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
        this.jobs = j.jobs.filter((x) => x && typeof x.cron === "string" && typeof x.task === "string");
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
      cron: j.cron,
      label: j.label || "",
      task: String(j.task).slice(0, 120),
      deliver: j.deliver || "none",
      sessionPath: j.sessionPath || null,
      cwd: j.cwd || null,
      enabled: j.enabled !== false,
      lastRunAt: j.lastRunAt || null,
      lastStatus: j.lastStatus || null,
      nextRunAt: j.enabled === false ? null : nextRun(j.cron),
    }));
  }

  add({ cron, task, label, deliver, sessionPath, cwd, permission }) {
    const c = parseCron(cron); // 非法直接抛
    const mode = ["none", "session", "new"].includes(deliver) ? deliver : "none";
    if (mode === "session" && !sessionPath) throw new Error("deliver=session 需要 sessionPath");
    if (this.jobs.length >= MAX_JOBS) throw new Error(`最多 ${MAX_JOBS} 个定时任务`);
    const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const job = {
      id,
      cron: c.expr,
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
      try {
        due = nextRun(job.cron, new Date((job.lastRunAt || job.createdAt || now) - 60_000));
      } catch { continue; }
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
