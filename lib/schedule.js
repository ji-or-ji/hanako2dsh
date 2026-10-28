/**
 * lib/schedule.js — 定时派活：到点跑一次 headless，按设定投递结果
 *
 * 投递三选一（对应用户要求）：
 *   none    → 不发送，只记进时间线
 *   session → 发到指定 Hana 会话（host bus: session:send）
 *   new     → 先建一个 Hana 会话，再发进去（session:create + session:send）
 *
 * 只在 Hana 运行期间生效（进程内 ticker），不依赖宿主的 task:schedule。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextRun, parseCron } from "./cron.js";

const TICK_MS = 30_000;
const MAX_JOBS = 50;

export class Scheduler {
  constructor({ bridge, log, bus, dataDir }) {
    this.bridge = bridge;
    this.log = log || console;
    this.bus = bus;
    this.path = join(dataDir, "schedules.json");
    this.jobs = [];
    this.timer = null;
    this.running = new Set();
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.path)) return;
      const j = JSON.parse(readFileSync(this.path, "utf-8"));
      if (Array.isArray(j?.jobs)) {
        this.jobs = j.jobs.filter(
        (x) => x && (typeof x.cron === "string" || typeof x.at === "number") && typeof x.task === "string",
      );
      }
    } catch (e) {
      this.log?.warn?.(`hanako2dsh: 读 schedules.json 失败 ${e?.message || e}`);
    }
  }

  #save() {
    try {
      writeFileSync(this.path, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), "utf-8");
    } catch (e) {
      this.log?.warn?.(`hanako2dsh: 写 schedules.json 失败 ${e?.message || e}`);
    }
  }

  list() {
    return this.jobs.map((j) => ({
      id: j.id,
      kind: j.kind === "once" ? "once" : "cron",
      cron: j.cron || null,
      at: j.at || null,
      label: j.label || "",
      task: String(j.task).slice(0, 120),
      deliver: j.deliver || "none",
      sessionPath: j.sessionPath || null,
      cwd: j.cwd || null,
      enabled: j.enabled !== false,
      lastRunAt: j.lastRunAt || null,
      lastStatus: j.lastStatus || null,
      nextRunAt: j.enabled === false ? null : this.#nextOf(j),
    }));
  }

  /** 某个任务的下一次触发时间（一次性任务直接用它自己的 at） */
  #nextOf(j) {
    if (j.kind === "once") return j.at && j.at > Date.now() ? j.at : null;
    try { return nextRun(j.cron); } catch { return null; }
  }

  add({ kind, cron, at, task, label, deliver, sessionPath, cwd, permission }) {
    const mode = ["none", "session", "new"].includes(deliver) ? deliver : "none";
    if (mode === "session" && !sessionPath) throw new Error("deliver=session 需要 sessionPath");
    if (this.jobs.length >= MAX_JOBS) throw new Error(`最多 ${MAX_JOBS} 个定时任务`);
    if (!String(task || "").trim()) throw new Error("任务内容不能为空");

    const k = kind === "once" ? "once" : "cron";
    let cronExpr = null;
    let atMs = null;
    if (k === "once") {
      atMs = typeof at === "number" ? at : Date.parse(String(at || ""));
      if (!Number.isFinite(atMs)) throw new Error("一次性任务需要合法的 at（毫秒或 ISO 时间）");
      if (atMs <= Date.now()) throw new Error("一次性任务的时间必须在将来");
    } else {
      cronExpr = parseCron(cron).expr; // 非法直接抛
    }

    const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const job = {
      id,
      kind: k,
      ...(k === "once" ? { at: atMs } : { cron: cronExpr }),
      task: String(task),
      label: String(label || task).slice(0, 40),
      deliver: mode,
      sessionPath: mode === "session" ? sessionPath : undefined,
      cwd: cwd || undefined,
      permission: permission || undefined,
      enabled: true,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this.#save();
    return this.list().find((j) => j.id === id);
  }

  remove(id) {
    const n = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length === n) return false;
    this.#save();
    return true;
  }

  setEnabled(id, on) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    j.enabled = !!on;
    this.#save();
    return true;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#tick(), TICK_MS);
    this.timer.unref?.();
    this.log?.info?.(`hanako2dsh: 定时派活已启动（${this.jobs.length} 个任务）`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  #tick() {
    const now = Date.now();
    for (const job of this.jobs) {
      if (job.enabled === false) continue;
      if (this.running.has(job.id)) continue;
      let due = null;
      if (job.kind === "once") {
        // 一次性：到点就跑一次，跑完自动停用
        due = job.at || null;
        if (job.lastRunAt) due = null;
      } else {
        try {
          due = nextRun(job.cron, new Date((job.lastRunAt || job.createdAt || now) - 60_000));
        } catch { continue; }
      }
      if (!due || due > now) continue;
      void this.#fire(job);
    }
  }

  async #fire(job) {
    this.running.add(job.id);
    job.lastRunAt = Date.now();
    this.#save();
    this.log?.info?.(`hanako2dsh: 定时任务触发 ${job.id} (${job.cron})`);
    try {
      const res = await this.bridge.runTask(job.task, {
        cwd: job.cwd,
        defer: false,
        permission: job.permission,
        agentName: "Hanako（定时）",
      });
      job.lastStatus = res?.ok ? "ok" : "fail";
      const text = this.#format(job, res);
      await this.#deliver(job, text);
    } catch (e) {
      job.lastStatus = "error";
      this.log?.warn?.(`hanako2dsh: 定时任务 ${job.id} 异常 ${e?.message || e}`);
      await this.#deliver(job, this.#format(job, { ok: false, stderr: String(e?.message || e) })).catch(() => {});
    } finally {
      this.running.delete(job.id);
      if (job.kind === "once") job.enabled = false;   // 一次性跑完即失效
      this.#save();
    }
  }

  #format(job, res) {
    const head = `[DSH 定时任务] ${job.label || job.id}`;
    const state = res?.ok ? "完成" : "失败";
    const body = res?.ok ? String(res.text ?? "").slice(0, 4000) : String(res?.stderr || res?.reason || "未知错误").slice(0, 1200);
    const sid = res?.sessionId ? `\n会话：${res.sessionId}` : "";
    return `${head}\n状态：${state}${sid}\n\n${body}`;
  }

  async #deliver(job, text) {
    const mode = job.deliver || "none";
    if (mode === "none") return;
    if (!this.bus?.request) {
      this.log?.warn?.("hanako2dsh: 没有宿主 bus，无法投递定时任务结果");
      return;
    }
    try {
      if (mode === "session") {
        await this.bus.request("session:send", { text, sessionPath: job.sessionPath });
        return;
      }
      if (mode === "new") {
        const created = await this.bus.request("session:create", {
          agentId: "hanako",
          cwd: job.cwd || undefined,
          workspaceFolders: job.cwd ? [job.cwd] : undefined,
          ownerPluginId: "hanako2dsh",
        });
        const sp = created?.session?.path || created?.sessionPath;
        if (!sp) throw new Error("session:create 没返回会话路径");
        await this.bus.request("session:send", { text, sessionPath: sp });
        this.log?.info?.(`hanako2dsh: 定时结果已投递到新会话 ${sp}`);
      }
    } catch (e) {
      this.log?.warn?.(`hanako2dsh: 定时结果投递失败（${mode}）${e?.message || e}`);
    }
  }
}
