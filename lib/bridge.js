/**
 * lib/bridge.js — DSH 桥核心
 *
 * 职责：
 *   1. 探空闲端口 → 生成 account overlay → spawn `dsh --profile web`
 *   2. 从 stdout 抓 `?token=` URL，GET 一次换取 dsh-auth cookie
 *   3. 在 127.0.0.1:<proxyPort> 起反向代理，注入 cookie、保持 Host、去掉 Origin
 *   4. 同时透传 HTTP 与 WebSocket upgrade（路径 /api/remote.mux）
 *   5. 进程退出自动重启并重新取 cookie
 *   6. 派活通道：spawn `dsh --profile headless --json`，解析 NDJSON
 *
 * 所有对外状态通过 getState() 暴露；进程级资源通过 dispose() 释放。
 */

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureTheme, isThemeActive, hasDshThemes } from "./theme.js";

export const DEFAULT_APP_DIR = "D:\\Program Files\\deepseek-harness";

/** 未配置安装目录时按优先级探测常见位置 */
function appDirCandidates() {
  const env = process.env || {};
  return [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "deepseek-harness"),
    env.ProgramFiles && join(env.ProgramFiles, "deepseek-harness"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "deepseek-harness"),
    "D:\\Program Files\\deepseek-harness",
    "C:\\Program Files\\deepseek-harness",
  ].filter(Boolean);
}

/** 目录里有没有官方 DSH 主程序 */
function looksLikeInstall(dir) {
  return !!dir && existsSync(join(dir, "DeepSeek Harness.exe"));
}

const OVERLAY_CONTENT = [
  "# 自动生成（hanako2dsh）：让拉起的实例走 DSH 账号登录，而非 API key",
  "- id: agent-default-model",
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  "  config:",
  "    provider: deepseek-account",
  "    model: deepseek-flash",
  "    reasoningEffort: high",
  "",
].join("\n");

/** 实例连续启动失败的自动重启上限；超限则停手并报错，绝不无限重试 */
const MAX_RESTART = 5;

/** 探一个空闲端口（listen 0 后立刻释放） */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 指定端口是否空闲（用于避免撞上残留实例） */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export class DshBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx?.log || console;
    this.dataDir = ctx?.dataDir || process.cwd();
    this.configPath = join(this.dataDir, "config.json");
    this.overlayPath = join(this.dataDir, "account-overlay.yml");

    this.child = null;          // web 实例子进程（当前）
    this.children = new Set();  // 所有拉起的 web 子进程（含重试期遗留，停时全部回收）
    this.cookie = null;         // dsh-auth-... 整段（含 cookie 名）
    this.webPort = null;
    this.proxyPort = null;
    this.proxyServer = null;
    this.sockets = new Set();   // 代理端所有 TCP 连接（含 keep-alive 与已升级的 WS）
    this.restartTimer = null;
    this.paused = false;        // 派活期间暂停 web 实例
    this.chatting = false;      // 正在派活（页面显示提示页）
    this.chatAgent = null;      // 派活发起者显示名
    this.restartCount = 0;      // 实例连续启动失败次数（退避用）
    this.lastActivity = null;   // DSH 会话最近活动（来自 projcache 明文投影）
    this.watcher = null;        // 会话库监听句柄
    this.actTimer = null;
    this.progress = null;       // 当前派活的实时进度（来自 headless 事件流）
    this.recentTasks = [];      // 最近派活记录（侧边栏用）
    this.timelines = new Map(); // 按窗口(cwd)分组：key -> 时间线条目[]（最新在后）
    this.activeKey = null;      // 当前活跃窗口（最近派活的那个）
    this.tlTimer = null;        // 时间线落盘去抖
    this.runChild = null;       // 当前 headless 派活子进程（急停用）
    this.currentOpId = null;    // 当前任务 id
    this.taskKey = null;        // 当前任务所属窗口（会随会话绑定一起迁移）
    this.stdoutBuf = "";
    this.stopping = false;
    this.status = "idle";       // idle | starting | ready | error | stopped
    this.lastError = null;
    this.startedAt = null;
    this.webExe = null;

    this.spawnClient = (cmd, args, opts) => spawn(cmd, args, opts);
    this.themeState = { available: false, active: false, hint: false };
    this.themeCheckedAt = 0;
    this.#loadTimelines();     // 恢复上次落盘的时间线（重启不丢）
  }

  // ── 配置 ────────────────────────────────────────────────────────────────
  getConfig() {
    const defaults = {
      dshAppDir: DEFAULT_APP_DIR,
      autoStart: true,
      defaultCwd: "",
      permissionMode: "danger-full-access",
      themeHintDismissed: false,
    };
    // 宿主 config 打底，dataDir/config.json 覆盖（否则 setConfig 写的键会读不回来）
    let base = null;
    try {
      const c = this.ctx?.config;
      if (c && typeof c.get === "function") base = c.get();
      else if (c && typeof c === "object" && !Array.isArray(c)) base = c;
    } catch { /* ignore */ }
    let fileCfg = {};
    try {
      if (existsSync(this.configPath)) fileCfg = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch { /* ignore */ }
    return { ...defaults, ...(base || {}), ...fileCfg };
  }

  setConfig(patch) {
    let cur = {};
    try {
      if (existsSync(this.configPath)) cur = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch { /* ignore */ }
    const next = { ...cur, ...patch };
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  // ── 路径解析 ────────────────────────────────────────────────────────────
  resolveSpec() {
    const cfg = this.getConfig();
    let appDir = cfg.dshAppDir || "";
    // 未配置或配置无效时，自动探测常见安装位置
    if (!looksLikeInstall(appDir)) {
      const hit = appDirCandidates().find(looksLikeInstall);
      appDir = hit || appDir || DEFAULT_APP_DIR;
    }
    const hostExe = join(appDir, "DeepSeek Harness.exe");
    const cliJs = join(
      appDir,
      "resources",
      "app.asar",
      "dsh",
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "cli.js",
    );
    return { appDir, hostExe, cliJs };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async start() {
    if (this.child && !this.stopping) return this.getState();
    this.stopping = false;
    this.restartCount = 0;      // 手动启动时重置退避计数
    mkdirSync(this.dataDir, { recursive: true });
    this.#writeOverlay();
    this.#watchSessions();
    this.#ensureTheme();        // 把 Hanako 皮肤装上（只装，不抢主题）
    if (!this.webPort || !(await isPortFree(this.webPort))) this.webPort = await findFreePort();
    if (!this.proxyPort || !(await isPortFree(this.proxyPort))) this.proxyPort = await findFreePort();
    await this.#startProxy();
    this.#spawnWeb();
    return this.getState();
  }

  /** 关闭代理监听并真正释放端口（proxyPort 数值保留，便于同端口重启） */
  async #stopProxy() {
    const server = this.proxyServer;
    const port = this.proxyPort;
    this.proxyServer = null;
    const n = this.sockets.size;
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    if (!server) {
      this.log?.info?.(`hanako2dsh: stop 时无代理 server（port=${port}）`);
      return;
    }
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try { server.close(done); } catch { done(); }
      setTimeout(done, 800); // 兜底：keep-alive 连接卡住时不至于挂死
    });
    this.log?.info?.(`hanako2dsh: 代理 ${port} 已关闭（断开 ${n} 个连接）`);
  }

  /** 权限等级（通过 DSH_PERMISSION_MODE 按进程下发）：read-only / workspace-write / danger-full-access */
  #permMode(override) {
    const m = override || this.getConfig().permissionMode || "danger-full-access";
    return ["read-only", "workspace-write", "danger-full-access"].includes(m) ? m : "danger-full-access";
  }

  // ── Hanako 皮肤（只装卡片，不抢主题）───────────────────────────────────
  #ensureTheme() {
    const pluginDir = this.ctx?.pluginDir || "";
    if (pluginDir) {
      try {
        const r = ensureTheme(pluginDir);
        this.log?.info?.(`hanako2dsh: 皮肤 ${r.ok ? r.reason : "跳过（" + r.reason + "）"}`);
      } catch (e) {
        this.log?.warn?.(`hanako2dsh: 皮肤安装失败 ${e?.message || e}`);
      }
    }
    this.#refreshThemeState(true);
  }

  #refreshThemeState(force = false) {
    const now = Date.now();
    if (!force && now - this.themeCheckedAt < 3000) return;
    this.themeCheckedAt = now;
    try {
      const available = hasDshThemes();
      const active = available && isThemeActive();
      const dismissed = this.getConfig().themeHintDismissed === true;
      this.themeState = { available, active, hint: available && !active && !dismissed };
    } catch { /* ignore */ }
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    // 把所有拉起的实例一并回收（重试期可能遗留多个）
    for (const c of this.children) {
      try { c.kill(); } catch { /* ignore */ }
    }
    this.children.clear();
    await this.#stopProxy();
    this.cookie = null;
    this.status = "stopped";
    return this.getState();
  }

  async restart() {
    await this.stop();
    this.webPort = null;        // 换端口重来，杠绝旧实例占位
    this.proxyPort = null;
    this.status = "idle";
    return this.start();
  }

  async dispose() {
    this.#saveTimelines(true);
    this.#stopWatch();
    await this.stop();
  }

  // ── DSH 会话活动监听（明文投影）──────────────────────────────────────────
  #projDir() {
    return join(os.homedir(), ".dsh", "storages", "session_projcache", "sessions");
  }

  #watchSessions() {
    if (this.watcher) return;
    const dir = this.#projDir();
    if (!existsSync(dir)) return;
    try {
      this.watcher = watch(dir, { persistent: false }, (_ev, name) => {
        if (!name || !String(name).endsWith(".json")) return;
        this.#noteSessionChange(join(dir, String(name)));
      });
      this.watcher.on?.("error", () => { /* ignore */ });
    } catch { /* ignore */ }
  }

  #stopWatch() {
    if (this.actTimer) { clearTimeout(this.actTimer); this.actTimer = null; }
    try { this.watcher?.close?.(); } catch { /* ignore */ }
    this.watcher = null;
  }

  #noteSessionChange(file) {
    if (this.actTimer) clearTimeout(this.actTimer);
    this.actTimer = setTimeout(() => {
      this.actTimer = null;
      try {
        const rec = JSON.parse(readFileSync(file, "utf-8"));
        const rows = rec?.record?.rows || {};
        const turns = rows.turnOutline?.val?.turns || [];
        const last = turns[turns.length - 1] || {};
        const title = rows.title?.val || "";
        const prompt = last.prompt || rows.titleInput?.val?.first?.text || "";
        const response = last.response || "";
        const at = rows.sessionListMetadata?.val?.lastPromptAt || Date.now();
        const sid = String(file).split(/[\\/]/).pop().replace(/\.json$/, "");
        const head = title || String(prompt).slice(0, 40) || sid;
        const tail = String(response).replace(/\s+/g, " ").slice(0, 120);
        this.lastActivity = {
          at,
          sessionId: sid,
          title,
          prompt: String(prompt).slice(0, 300),
          response: String(response).slice(0, 300),
          summary: `${head}${tail ? "：" + tail : ""}`,
        };
      } catch { /* ignore */ }
    }, 400);
  }

  // ── overlay ─────────────────────────────────────────────────────────────
  #writeOverlay() {
    try {
      writeFileSync(this.overlayPath, OVERLAY_CONTENT, "utf-8");
    } catch (err) {
      this.log?.error?.(`hanako2dsh: 写 overlay 失败: ${err.message}`);
    }
  }

  // ── web 实例 spawn ──────────────────────────────────────────────────────
  /** 派活期间暂停 web：释放它占用的会话写句柄，并等进程真正退出 */
  #pauseWeb() {
    return new Promise((resolve) => {
      const child = this.child;
      this.log?.info?.(`hanako2dsh: pauseWeb child=${child ? child.pid : "null"}`);
      if (!child) { resolve(); return; }
      this.paused = true;
      this.child = null;
      this.cookie = null;
      this.status = "starting";
      this.lastError = null;
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      child.once("exit", fin);
      try { child.kill(); } catch { fin(); }
      setTimeout(fin, 1500);
    });
  }

  /** 派活结束后恢复 web */
  #resumeWeb() {
    if (!this.paused) return;
    this.paused = false;
    if (!this.stopping) this.#spawnWeb();
  }

  #spawnWeb() {
    const { hostExe, cliJs } = this.resolveSpec();
    if (!existsSync(hostExe)) {
      this.status = "error";
      this.lastError = `找不到 DSH 可执行文件: ${hostExe}`;
      this.log?.error?.(`hanako2dsh: ${this.lastError}`);
      return;
    }
    this.webExe = hostExe;
    const args = [
      "--expose-internals",
      cliJs,
      "--patch",
      this.overlayPath,
      "--profile",
      "web",
      "--port",
      String(this.webPort),
      "--no-open",
    ];
    this.status = "starting";
    this.lastError = null;
    this.stdoutBuf = "";
    this.startedAt = Date.now();
    this.log?.info?.(`hanako2dsh: 启动 web 实例 127.0.0.1:${this.webPort}`);

    let child;
    try {
      child = this.spawnClient(hostExe, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_PERMISSION_MODE: this.#permMode() },
      });
    } catch (err) {
      this.status = "error";
      this.lastError = `spawn 失败: ${err.message}`;
      this.log?.error?.(`hanako2dsh: ${this.lastError}`);
      return;
    }
    this.child = child;
    this.children.add(child);

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      this.stdoutBuf += chunk;
      if (this.stdoutBuf.length > 65536) this.stdoutBuf = this.stdoutBuf.slice(-32768);
      if (!this.cookie) {
        const m = this.stdoutBuf.match(/dsh web:\s+(http:\/\/\S+\?token=\S+)/);
        if (m) void this.#login(m[1]);
      }
    });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line && !/DeprecationWarning|ExperimentalWarning/.test(line)) {
        this.log?.info?.(`hanako2dsh[stderr]: ${line.slice(0, 300)}`);
      }
    });
    child.on("exit", (code) => {
      this.children.delete(child);
      if (this.child === child) this.child = null;
      if (this.stopping || this.paused) return;
      this.cookie = null;
      this.restartCount = (this.restartCount || 0) + 1;
      // 连续失败超限：停手，不再每 2 秒撞一次墙
      if (this.restartCount > MAX_RESTART) {
        this.status = "error";
        this.lastError =
          `实例连续 ${this.restartCount} 次启动失败（最后 code=${code}），已停止自动重启。` +
          `常见原因：本机已有另一个 DSH 在跑（例如桌面端），共用同一份账号目录导致新实例起不来。`;
        this.log?.error?.(`hanako2dsh: ${this.lastError}`);
        return;
      }
      // 指数退避：2s, 4s, 8s, 16s, 30s(上限)
      const delay = Math.min(30000, 2000 * Math.pow(2, this.restartCount - 1));
      this.status = "starting";
      this.lastError = `实例退出 (code=${code})，${Math.round(delay / 1000)}s 后第 ${this.restartCount}/${MAX_RESTART} 次重启`;
      this.log?.error?.(`hanako2dsh: ${this.lastError}`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopping && !this.paused) this.#spawnWeb();
      }, delay);
    });
    child.on("error", (err) => {
      this.children.delete(child);
      this.status = "error";
      this.lastError = `子进程错误: ${err.message}`;
      this.log?.error?.(`hanako2dsh: ${this.lastError}`);
    });
  }

  async #login(tokenUrl) {
    try {
      const res = await fetch(tokenUrl, { redirect: "manual" });
      const getSetCookie = res.headers.getSetCookie?.() ?? [];
      const raw =
        getSetCookie.find((c) => c.startsWith("dsh-auth-")) ||
        res.headers.get("set-cookie");
      if (!raw) throw new Error(`响应里没有 dsh-auth cookie (status=${res.status})`);
      this.cookie = raw.split(";")[0];
      this.status = "ready";
      this.lastError = null;
      this.restartCount = 0;      // 登录成功，退避计数归零
      this.log?.info?.(`hanako2dsh: 登录成功，已持有会话 cookie`);
    } catch (err) {
      this.cookie = null;
      this.status = "error";
      this.lastError = `登录取 cookie 失败: ${err.message}`;
      this.log?.error?.(`hanako2dsh: ${this.lastError}`);
    }
  }

  /** 上游 401：疑似会话 cookie 失效，节流重启实例以重新签发 */
  #noteUnauthorized() {
    const now = Date.now();
    if (now - (this.lastAuthRestart || 0) < 60000) return;
    this.lastAuthRestart = now;
    this.log?.warn?.("hanako2dsh: 上游返回 401，疑似会话 cookie 失效，重启 web 实例重新登录（端口保持不变）");
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
  }

  // ── 代理 ────────────────────────────────────────────────────────────────
  #startProxy() {
    if (this.proxyServer) return Promise.resolve();
    const server = http.createServer((req, res) => this.#handleHttp(req, res));
    server.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));
    // 跟踪每个 TCP 连接，stop 时逐个断开，否则 keep-alive / WS 会拖住 close()
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.proxyPort, "127.0.0.1", () => {
        server.removeListener("error", reject);
        this.proxyServer = server;
        this.log?.info?.(`hanako2dsh: 代理已监听 http://127.0.0.1:${this.proxyPort}/`);
        resolve();
      });
    });
  }

  #buildUpstreamHeaders(req) {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.cookie;
    delete headers.origin;
    delete headers["accept-encoding"];
    headers.host = `127.0.0.1:${this.webPort}`;
    headers.cookie = this.cookie;
    return headers;
  }

  // ── 宿主 deferred 通道（登记占位 / 结果回注对话）────────────────────────
  #bus() {
    return this.ctx?.bus || null;
  }

  async #deferRegister(taskId, sessionPath, meta) {
    const bus = this.#bus();
    if (!bus?.request || !sessionPath || !taskId) return false;
    try { await bus.request("deferred:register", { taskId, sessionPath, meta }); return true; }
    catch (e) { this.log?.warn?.(`hanako2dsh: deferred:register 失败 ${e?.message || e}`); return false; }
  }

  async #deferResolve(taskId, result) {
    const bus = this.#bus();
    if (!bus?.request || !taskId) return false;
    try { await bus.request("deferred:resolve", { taskId, result }); return true; }
    catch (e) { this.log?.warn?.(`hanako2dsh: deferred:resolve 失败 ${e?.message || e}`); return false; }
  }

  async #deferFail(taskId, error) {
    const bus = this.#bus();
    if (!bus?.request || !taskId) return false;
    try { await bus.request("deferred:fail", { taskId, error }); return true; }
    catch (e) { this.log?.warn?.(`hanako2dsh: deferred:fail 失败 ${e?.message || e}`); return false; }
  }

  /** 急停：中止当前正在跑的 headless 派活 */
  abortRun() {
    const child = this.runChild;
    if (!child) return false;
    this.log?.warn?.("hanako2dsh: 收到急停，中止当前派活");
    this.#pushTimeline("fail", "已急停");
    try { child.kill(); } catch { /* ignore */ }
    return true;
  }

  /** 页面心跳：让嵌在 Hana 里的页面知道“是否正在派活 / 是否就绪”（跨源放开） */
  #handleHeartbeat(res) {
    this.#refreshThemeState();
    const body = JSON.stringify({
      chatting: this.chatting,
      chatAgent: this.chatAgent,
      ready: this.status === "ready" && !!this.cookie,
      status: this.status,
      lastError: this.lastError,
      lastActivity: this.lastActivity?.summary || "",
      progress: this.progress?.text || "",
      recentTasks: this.recentTasks.slice(0, 6),
      timeline: (this.timelines.get(this.activeKey) || []).slice(-40),
      activeKey: this.activeKey,
      windows: this.#windowList(),
      running: !!this.runChild,
      theme: this.themeState,
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  #handleHttp(req, res) {
    // 心跳不转发上游，直接由本地代理回答
    if (req.url === "/__hb" || req.url.startsWith("/__hb?")) {
      this.#handleHeartbeat(res);
      return;
    }
    // 控制通道：侧边栏急停按钮调用（跨源放开）
    if (req.url === "/__ctl" || req.url.startsWith("/__ctl?")) {
      const u = new URL(req.url, "http://127.0.0.1");
      const action = u.searchParams.get("action") || "";
      let ok = false;
      if (action === "abort") ok = this.abortRun();
      else if (action === "theme_hint_off") {
        this.setConfig({ themeHintDismissed: true });
        this.#refreshThemeState(true);
        ok = true;
      }
      else if (action === "theme_recheck") {
        this.#ensureTheme();
        ok = true;
      }
      else if (action === "focus") {
        const key = u.searchParams.get("key") || "";
        if (this.timelines.has(key)) { this.activeKey = key; ok = true; this.#saveTimelines(); }
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok, action }));
      return;
    }
    if (!this.cookie) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("DSH 实例尚未就绪（正在拉起或登录），请稍候刷新。");
      return;
    }
    let headers;
    try {
      headers = this.#buildUpstreamHeaders(req);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err.message));
      return;
    }
    const proxied = http.request(
      {
        host: "127.0.0.1",
        port: this.webPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (up) => {
        if (up.statusCode === 401) this.#noteUnauthorized();
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") continue;
          out[k] = v;
        }
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      },
    );
    proxied.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`代理错误: ${err.message}`);
    });
    req.on("error", () => { try { proxied.destroy(); } catch { /* ignore */ } });
    req.pipe(proxied);
  }

  #handleUpgrade(req, clientSocket, head) {
    if (!this.cookie) {
      clientSocket.destroy();
      return;
    }
    let headers;
    try {
      headers = this.#buildUpstreamHeaders(req);
    } catch {
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(this.webPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
        else lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const done = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", done);
    clientSocket.on("error", done);
  }

  // ── 派活（headless NDJSON）──────────────────────────────────────────────
  /**
   * 跑一次 headless 任务。返回 { ok, sessionId, text, usage, reason, events, stderr, code }
   */
  async runTask(task, opts = {}) {
    const wasRunning = !!this.child;
    this.chatting = true;
    this.progress = null;
    this.chatAgent = opts.agentName || this.chatAgent || "Hanako";
    const sessionPath = opts.sessionPath || null;
    const opId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const entry = { opId, label: String(task).slice(0, 60), at: Date.now(), status: "running" };
    this.recentTasks.unshift(entry);
    if (this.recentTasks.length > 8) this.recentTasks.length = 8;
    this.currentOpId = opId;
    // 窗口 = 一次 DSH 会话：续会话用其 id；新会话先占临时位，拿到真实 id 后迁移
    this.activeKey = opts.sessionId || `new:${opId}`;
    if (!this.timelines.has(this.activeKey)) this.timelines.set(this.activeKey, []);
    this.taskKey = this.activeKey;
    this.log?.info?.(`hanako2dsh: runTask activeKey=${this.activeKey} sid=${opts.sessionId || "-"}`);
    this.#pushTimeline("start", `派活：${String(task).slice(0, 80)}`);
    const mark = (ok) => { entry.status = ok ? "done" : "failed"; entry.at = Date.now(); };
    // 有 sessionPath 且未显式要同步时，走宿主 deferred 通道：工具立即返回，结果自动回到对话
    const deferred = opts.defer !== false && !!sessionPath && !!this.#bus();
    if (deferred) {
      await this.#deferRegister(opId, sessionPath, {
        type: "dsh-run",
        label: String(task).slice(0, 120),
        deliveryIntent: "trigger_parent_turn",
        notifyAgentOnFailure: true,
      });
    }
    this.log?.info?.(`hanako2dsh: runTask 开始 wasRunning=${wasRunning} deferred=${deferred} opId=${opId}`);
    if (wasRunning) await this.#pauseWeb();   // 腾出会话写句柄，否则 headless 无法 adopt

    const run = this.#runHeadless(task, opts);
    const settle = async (res) => {
      mark(res?.ok);
      this.#pushTimeline(res?.ok ? "done" : "fail", res?.ok ? "任务完成" : `任务失败：${String(res?.stderr || res?.error || res?.reason || "").slice(0, 120)}`);
      this.currentOpId = null;
      this.chatting = false;
      if (wasRunning) this.#resumeWeb();
      // 任务结束时把焦点归位到本窗口（taskKey 随会话绑定迁移，不会退回临时键）
      if (this.taskKey) this.activeKey = this.taskKey;
      if (!deferred) return;
      if (res?.ok) {
        await this.#deferResolve(opId, {
          kind: "dsh-done",
          opId,
          tool: "dsh_run",
          status: "completed",
          sessionId: res.sessionId ?? null,
          conclusion: String(res.text ?? "").slice(0, 4000),
          usage: res.usage ?? null,
          reason: res.reason ?? null,
        });
      } else {
        await this.#deferFail(opId, {
          message: String(res?.stderr || res?.error || res?.reason || "task failed").slice(0, 300),
        });
      }
    };

    if (deferred) {
      run.then(settle, (e) => settle({ ok: false, error: e?.message || String(e) }));
      return {
        ok: true,
        deferred: true,
        opId,
        sessionId: null,
        text: `已派单（${opId}）。任务在后台执行，完成后结果会自动回到对话；进度可查 dsh_status。`,
        usage: null,
        reason: "deferred",
      };
    }

    try {
      const res = await run;
      mark(res?.ok);
      return res;
    } finally {
      this.chatting = false;
      if (wasRunning) this.#resumeWeb();
    }
  }

  #runHeadless(task, opts = {}) {
    const { hostExe, cliJs } = this.resolveSpec();
    const cfg = this.getConfig();
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const args = [
      "--expose-internals",
      cliJs,
      "--patch",
      this.overlayPath,
      "--profile",
      "headless",
      "--json",
    ];
    if (opts.sessionId) args.push("--session-id", opts.sessionId);
    args.push("-");

    const cwd = opts.cwd || cfg.defaultCwd || process.env.HANA_WORKSPACE || process.cwd();

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnClient(hostExe, args, {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          cwd,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_PERMISSION_MODE: this.#permMode(opts.permission) },
        });
      } catch (err) {
        resolve({ ok: false, error: `spawn 失败: ${err.message}` });
        return;
      }
      this.runChild = child;   // 供急停使用

      const events = [];
      let lineBuf = "";
      let stderr = "";
      let sessionId = null;
      let finalText = "";
      let usage = null;
      let reason = null;
      let settled = false;

      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.runChild === child) this.runChild = null;
        const ok = code === 0 && (!reason || reason === "completed");
        resolve({
          ok,
          code,
          sessionId,
          text: finalText,
          usage,
          reason: reason || (code === 0 ? "completed" : "error"),
          events,
          stderr: stderr.slice(0, 4000),
        });
      };

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        reason = reason || "timeout";
        finish(-1);
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        lineBuf += chunk;
        let idx;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          events.push(evt);
          this.#noteProgress(evt);
          if (evt.type === "session" && evt.sessionId) sessionId = evt.sessionId;
          else if (evt.type === "status" && evt.usage) usage = evt.usage;
          else if (evt.type === "final") finalText = evt.text ?? finalText;
          else if (evt.type === "status" && evt.phase === "turn_end" && evt.reason) {
            reason = evt.reason.kind || evt.reason;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("error", (err) => {
        stderr += `\n[spawn error] ${err.message}`;
        finish(-1);
      });
      child.on("exit", (code) => finish(code ?? -1));

      try {
        child.stdin.write(typeof task === "string" ? task : String(task ?? ""));
        child.stdin.end();
      } catch (err) {
        stderr += `\n[stdin error] ${err.message}`;
      }
    });
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  // ── 派活时间线 ──────────────────────────────────────────────────────────
  /** 新会话拿到真实 sessionId 后，把临时窗口迁移到正式窗口 */
  #bindSession(sid) {
    const oldKey = this.activeKey;
    if (!oldKey || !sid || oldKey === sid) return;
    if (!String(oldKey).startsWith("new:")) return;
    this.log?.info?.(`hanako2dsh: bindSession ${oldKey} -> ${sid}`);
    const arr = this.timelines.get(oldKey) || [];
    this.timelines.delete(oldKey);
    const prev = this.timelines.get(sid);
    this.timelines.set(sid, prev ? prev.concat(arr) : arr);
    this.activeKey = sid;
    if (this.taskKey === oldKey) this.taskKey = sid;
  }

  #pushTimeline(kind, text) {
    const s = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!s) return;
    const key = this.activeKey || "__default__";
    let arr = this.timelines.get(key);
    if (!arr) { arr = []; this.timelines.set(key, arr); }
    arr.push({ ts: Date.now(), kind, text: s.slice(0, 200), opId: this.currentOpId });
    if (arr.length > 60) arr.splice(0, arr.length - 60);
    this.#saveTimelines();
  }

  /** 时间线落盘：去抖写入插件数据目录，重启后可恢复 */
  #tlPath() {
    return join(this.dataDir, "timelines.json");
  }

  #loadTimelines() {
    try {
      const p = this.#tlPath();
      if (!existsSync(p)) return;
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      const wins = raw?.windows;
      if (wins && typeof wins === "object") {
        for (const [k, v] of Object.entries(wins)) {
          if (Array.isArray(v) && v.length) this.timelines.set(k, v.slice(-60));
        }
      }
      if (raw?.activeKey && this.timelines.has(raw.activeKey)) this.activeKey = raw.activeKey;
      if (this.timelines.size) this.log?.info?.(`hanako2dsh: 已恢复 ${this.timelines.size} 个窗口的时间线`);
    } catch { /* ignore */ }
  }

  #saveTimelines(immediate = false) {
    const write = () => {
      this.tlTimer = null;
      try {
        mkdirSync(this.dataDir, { recursive: true });
        const wins = {};
        const entries = [...this.timelines.entries()]
          .filter(([, v]) => v.length)
          .sort((a, b) => (b[1][b[1].length - 1]?.ts || 0) - (a[1][a[1].length - 1]?.ts || 0))
          .slice(0, 30);
        for (const [k, v] of entries) wins[k] = v.slice(-60);
        writeFileSync(this.#tlPath(), JSON.stringify({ version: 1, activeKey: this.activeKey, windows: wins }), "utf-8");
      } catch { /* ignore */ }
    };
    if (this.tlTimer) { clearTimeout(this.tlTimer); this.tlTimer = null; }
    if (immediate) write();
    else this.tlTimer = setTimeout(write, 600);
  }

  /** 窗口列表（侧边栏切换用）：仅列出有时间线的窗口 */
  #windowList() {
    const short = (k) => (k.startsWith("session-") ? k.slice(8, 16) : String(k).slice(0, 12));
    return [...this.timelines.entries()]
      .filter(([, v]) => v.length)
      .map(([k, v]) => {
        const first = v.find((it) => it.kind === "start");
        const t = String(first?.text || "").replace(/^派活：/, "").trim();
        return {
          key: k,
          label: t ? t.slice(0, 18) : short(k),
          count: v.length,
          active: k === this.activeKey,
        };
      });
  }

  // ── 派活进度 ────────────────────────────────────────────────────────────
  #noteProgress(evt) {
    const t = evt?.type;
    if (t === "session" && evt.sessionId) { this.#bindSession(evt.sessionId); return; }
    if (t === "status") {
      if (evt.phase === "turn_start") this.progress = { at: Date.now(), text: "开始处理" };
      else if (evt.phase === "step_start") this.progress = { at: Date.now(), text: `第 ${evt.step || "?"} 步` };
      else if (evt.phase === "turn_end") this.progress = { at: Date.now(), text: "收尾" };
    } else if (t === "thinking") {
      if (evt.text) this.progress = { at: Date.now(), text: "思考中…" };
    } else if (t === "text") {
      if (evt.text) {
        this.progress = { at: Date.now(), text: String(evt.text).replace(/\s+/g, " ").trim().slice(0, 80) };
        this.#pushTimeline("text", evt.text);
      }
    } else if (t === "tool_call") {
      const tt = this.#toolText(evt);
      this.progress = { at: Date.now(), text: tt, tool: evt.tool };
      this.#pushTimeline("tool", tt);
    } else if (t === "final") {
      this.progress = { at: Date.now(), text: "完成" };
    }
  }

  #toolText(evt) {
    let hint = "";
    try {
      const inp = typeof evt.input === "string" ? JSON.parse(evt.input) : evt.input || {};
      hint = inp.file_path || inp.path || inp.command || inp.cmd || inp.pattern || inp.query || "";
    } catch { /* ignore */ }
    const h = String(hint).replace(/\s+/g, " ").trim().slice(0, 60);
    return h ? `${evt.tool} · ${h}` : String(evt.tool || "工具");
  }

  getState() {
    return {
      status: this.status,
      ready: this.status === "ready" && !!this.cookie,
      webPort: this.webPort,
      proxyPort: this.proxyPort,
      proxyUrl: this.proxyPort ? `http://127.0.0.1:${this.proxyPort}/` : null,
      pid: this.child?.pid ?? null,
      hasCookie: !!this.cookie,
      startedAt: this.startedAt,
      lastError: this.lastError,
      hasProxyServer: !!this.proxyServer,
      trackedSockets: this.sockets ? this.sockets.size : -1,
      chatting: this.chatting,
      chatAgent: this.chatAgent,
      lastActivity: this.lastActivity,
      progress: this.progress,
      recentTasks: this.recentTasks,
      timeline: this.timelines.get(this.activeKey) || [],
      activeKey: this.activeKey,
      windows: this.#windowList(),
      permissionMode: this.getConfig().permissionMode,
      theme: this.themeState,
    };
  }
}

// 插件级单例：index.js 与 routes/tools 共享（挂在 ctx 上做双保险）
const KEY = "__dshBridgeInstance";
export function getBridge(ctx) {
  if (ctx && ctx[KEY]) return ctx[KEY];
  const b = new DshBridge(ctx);
  if (ctx) ctx[KEY] = b;
  return b;
}
