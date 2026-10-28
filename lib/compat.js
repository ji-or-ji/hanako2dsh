/**
 * lib/compat.js — 跨 DSH 版本的兼容探测
 *
 * 原则：**能探测就不硬编码版本号**。dsh-ops 这类插件换过条目 id
 * （0.3.x 是 dsh-ops-shell / file / background / ptc，0.4.x 换成了 mode-minimal、
 *  mode-standard、mode-ptc、mode-cordis、discovery、panel、tui），
 * 写死任何一套都会在另一半机器上失效。所以直接读它自己装进来的
 * cordis.patch.yml，按实际插入的 id 生成覆盖层。
 */

import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 老版本（dsh-ops <= 0.3.x）的条目 id，读不到包时兜底 */
export const LEGACY_OPS_IDS = ["dsh-ops-shell", "dsh-ops-file", "dsh-ops-background", "dsh-ops-ptc"];

/** 某个 profile 里装没装 dsh-ops，以及它注册了哪些条目 id */
export function probeOps(profile = "headless") {
  const dir = join(os.homedir(), ".dsh", "profiles", profile);
  const pkgJson = join(dir, "node_modules", "dsh-ops", "package.json");
  if (!existsSync(pkgJson)) return { installed: false, version: null, ids: LEGACY_OPS_IDS, source: "legacy" };
  let version = null;
  try {
    version = JSON.parse(readFileSync(pkgJson, "utf-8")).version || null;
  } catch { /* ignore */ }
  // 优先读它自己的补丁文件：里面就是实际插入的 id 列表
  const ymls = [join(dir, "node_modules", "dsh-ops", "cordis.patch.yml")];
  for (const yml of ymls) {
    if (!existsSync(yml)) continue;
    try {
      const txt = readFileSync(yml, "utf-8");
      const ids = [...txt.matchAll(/^[ \t]*-[ \t]*id:[ \t]*([A-Za-z0-9._@/-]+)/gm)].map((m) => m[1]);
      const uniq = [...new Set(ids.map((s) => s.trim()))].filter(Boolean);
      if (uniq.length) return { installed: true, version, ids: uniq, source: "package" };
    } catch { /* ignore */ }
  }
  return { installed: true, version, ids: LEGACY_OPS_IDS, source: "legacy-fallback" };
}

/** 生成“本次不加载 dsh-ops”的覆盖层内容 */
export function buildOpsOffOverlay(ids, note = "") {
  const head = "# 自动生成（hanako2dsh）：本次派活不加载 dsh-ops 的工具" + (note ? `（${note}）` : "");
  const body = ids.map((id) => `- id: ${id}\n  disabled: true`);
  return [head, ...body, ""].join("\n");
}

/** 某个 profile 里是否装了官方定时任务插件（@deepseek-ai/dsh-schedule） */
export function probeSchedule(profile = "web") {
  const dir = join(os.homedir(), ".dsh", "profiles", profile);
  const cands = [
    join(dir, "node_modules", "@deepseek-ai", "dsh-schedule", "package.json"),
    join(dir, "node_modules", "dsh-schedule", "package.json"),
  ];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    try {
      const v = JSON.parse(readFileSync(p, "utf-8")).version || null;
      return { installed: true, version: v, profile, tools: ["schedule_create", "schedule_list", "schedule_delete"] };
    } catch { /* ignore */ }
  }
  return { installed: false, version: null, profile, tools: [] };
}
