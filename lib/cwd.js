/**
 * lib/cwd.js — 派活工作目录的解析
 *
 * 优先级（从高到低）：
 *   1. explicit  显式传入的 cwd（单次派活覆盖）
 *   2. session-pin 本 Hana 会话里临时指定的目录（会话级，不跨会话）
 *   3. session   本 Hana 会话自己的工作目录（读会话文件头的 cwd）
 *   4. desk      agent 的桌面（agents/<id>/config.yaml 里的 desk.home_folder）
 *   5. config    插件配置里的 defaultCwd
 *   6. process   HANA_WORKSPACE 或进程 cwd
 */

import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 这次调用属于哪个 Hana 会话（会话级临时目录的键） */
export function hanaSessionKey(toolCtx) {
  return (
    toolCtx?.sessionId ||
    toolCtx?.sessionRef?.sessionId ||
    toolCtx?.sessionPath ||
    toolCtx?.sessionRef?.sessionPath ||
    null
  );
}

/** 读 Hana 会话文件头里的 cwd */
export function sessionCwdFromFile(sessionPath) {
  if (!sessionPath || !existsSync(sessionPath)) return null;
  try {
    const head = readFileSync(sessionPath, "utf-8").split("\n", 1)[0];
    const j = JSON.parse(head);
    const c = j?.cwd;
    return typeof c === "string" && c.trim() ? c.trim() : null;
  } catch {
    return null;
  }
}

/** agent 的桌面：从 agents/<id>/sessions/... 反推 agent 目录，读 config.yaml 的 desk.home_folder */
export function agentDeskCwd(sessionPath) {
  const m = /[\\/]agents[\\/]([^\\/]+)[\\/]sessions[\\/]/i.exec(String(sessionPath || ""));
  if (!m) return null;
  const cfg = join(os.homedir(), ".hanako", "agents", m[1], "config.yaml");
  if (!existsSync(cfg)) return null;
  try {
    const txt = readFileSync(cfg, "utf-8");
    const mm = /^\s*home_folder:\s*(.+?)\s*$/m.exec(txt);
    if (!mm) return null;
    const v = mm[1].replace(/^["']|["']$/g, "").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** 解析出本次派活该用哪个目录 */
export function resolveCwd({ explicit, pinned, sessionPath, fallback } = {}) {
  if (explicit && String(explicit).trim()) return { cwd: String(explicit).trim(), source: "explicit" };
  if (pinned && String(pinned).trim()) return { cwd: String(pinned).trim(), source: "session-pin" };
  const sc = sessionCwdFromFile(sessionPath);
  if (sc) return { cwd: sc, source: "session" };
  const desk = agentDeskCwd(sessionPath);
  if (desk) return { cwd: desk, source: "desk" };
  if (fallback && String(fallback).trim()) return { cwd: String(fallback).trim(), source: "config" };
  return { cwd: process.env.HANA_WORKSPACE || process.cwd(), source: "process" };
}
