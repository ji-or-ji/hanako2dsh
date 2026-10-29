/**
 * lib/client.js — App 侧的桥客户端。
 *
 * v2 里 App 进程碰不到网、也读不到 ~/.dsh，桥整个搬进受管运行时（runtime/server.mjs）。
 * 两边只通过一条本机回环 HTTP 通道说话：
 *   App ──ctx.runtime.fetch──▶ 127.0.0.1:41888/__api/* ──▶ DshBridge
 *
 * 端口写死 41888：页面里的 iframe 直接指向它，端口一变旧页面就白屏。
 * 桥那边被占用会直接启动失败，不会偷偷换端口。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROXY_PORT = 41888;
export const READY_MARKER = "HANAKO2DSH_READY";

/** 设置页里由这个 App 管、需要推给桥的那几个键 */
const SETTING_KEYS = ["dshAppDir", "autoStart", "defaultCwd", "permissionMode", "skinEnabled"];

export function createBridgeClient(sdk) {
  const state = { runtimeId: null, starting: null, lastError: null };

  const configPath = () => join(sdk.dataDir, "config.json");

  function readLocalConfig() {
    try {
      if (!existsSync(configPath())) return {};
      return JSON.parse(readFileSync(configPath(), "utf-8")) || {};
    } catch {
      return {};
    }
  }

  function writeLocalConfig(patch) {
    const next = { ...readLocalConfig(), ...patch };
    mkdirSync(sdk.dataDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  /**
   * 桥只认 dataDir/config.json，不认宿主的设置表，所以每次起运行时先把设置页的值写进去。
   * sessionCwd（会话临时目录）、windowsCollapsed 这类运行时自己的键原样保留。
   */
  async function pushSettings() {
    let values = {};
    try {
      values = (await sdk.config.getAll()) || {};
    } catch {
      values = {};
    }
    const patch = {};
    for (const key of SETTING_KEYS) {
      const value = values[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value === "") continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length) writeLocalConfig(patch);
    return readLocalConfig();
  }

  async function startRuntime() {
    await pushSettings();
    const info = await sdk.runtime.start({
      runtime: "node",
      entry: "runtime/server.mjs",
      profile: "local-machine",
      network: "external",
      args: ["--data", sdk.dataDir, "--port", String(PROXY_PORT)],
      service: { port: PROXY_PORT, readyMarker: READY_MARKER, id: "dsh" },
    });
    state.runtimeId = info.runtimeId;
    state.lastError = null;
    return info;
  }

  const DEAD = new Set(["failed", "stopped", "exited"]);

  async function ensure(force = false) {
    if (state.runtimeId && !force) {
      const info = await sdk.runtime.get(state.runtimeId).catch(() => null);
      if (info && !DEAD.has(info.state)) return info;
      state.runtimeId = null;
    }
    if (!state.starting) {
      state.starting = startRuntime()
        .catch((err) => {
          state.lastError = String(err?.message || err);
          throw err;
        })
        .finally(() => {
          state.starting = null;
        });
    }
    return state.starting;
  }

  /** 等到服务真正 ready（readyMarker 出现）才允许发请求 */
  async function waitReady(timeoutMs = 90000) {
    const info0 = await ensure();
    const deadline = Date.now() + timeoutMs;
    let info = info0;
    while (Date.now() < deadline) {
      if (info?.service?.state === "ready") return info;
      if (info && DEAD.has(info.state)) {
        throw new Error(`DSH 运行时已退出（${info.state}${info.exitCode != null ? `，退出码 ${info.exitCode}` : ""}）`);
      }
      await new Promise((r) => setTimeout(r, 400));
      const id = state.runtimeId;
      if (!id) throw new Error("运行时句柄丢了");
      info = await sdk.runtime.get(id).catch(() => null);
      if (!info) throw new Error("运行时记录不见了（可能已被停止）");
    }
    throw new Error("等 DSH 就绪超时（90 秒），看一眼 dsh_status 的 lastError");
  }

  async function api(path, init) {
    const attempt = async () => {
      const info = await waitReady();
      const res = await sdk.runtime.fetch(info.runtimeId, path, init);
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: `桥返回了非 JSON：${text.slice(0, 200)}` };
      }
      if (!res.ok && data && data.ok !== false) data.ok = false;
      return data;
    };

    try {
      return await attempt();
    } catch (err) {
      // 服务重启过一次（DSH 崩了自动拉起）时，把运行时记录刷新后重试一次
      state.runtimeId = null;
      await ensure(true).catch(() => {});
      return attempt();
    }
  }

  const get = (path) => api(path);
  const post = (path, body) => api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });

  async function stopRuntime() {
    if (!state.runtimeId) return { ok: true, stopped: false };
    const id = state.runtimeId;
    state.runtimeId = null;
    await sdk.runtime.stop(id).catch(() => {});
    return { ok: true, stopped: true };
  }

  return {
    state,
    ensure,
    waitReady,
    api,
    get,
    post,
    stopRuntime,
    pushSettings,
    readLocalConfig,
    writeLocalConfig,
    get running() {
      return Boolean(state.runtimeId);
    },
  };
}
