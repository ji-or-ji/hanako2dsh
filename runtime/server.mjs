#!/usr/bin/env node
/**
 * runtime/server.mjs — 受管运行时入口。
 *
 * v2 的 AppHost 把 net / dns 关了、也读不到 ~/.dsh，而 DshBridge 两样都要：
 * 它要起本地代理、要 spawn DSH、要读 DSH 的 profile 与账号文件。所以桥整个搬进
 * 这个受管进程里跑（profile: local-machine、network: external），App 侧只留一层
 * HTTP 客户端。
 *
 * 启动参数（由 index.js 通过 ctx.runtime.start 的 args 传入）：
 *   --data  <App 数据目录>     时间线、账号 overlay、config.json 都落这里
 *   --port  <代理端口>         默认 41888；被占用就直接失败，不自作主张换端口
 *
 * 代理端口必须稳定：页面里的 iframe 直接指向 127.0.0.1:<port>，端口一变旧页面就白屏。
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DshBridge, isPortFree } from "../lib/bridge.js";
import { applyRealHome } from "../lib/home.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = join(HERE, "..");

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "41888"));
const DATA_DIR = arg("data", process.cwd());

mkdirSync(DATA_DIR, { recursive: true });

const log = {
  debug: () => {},
  info: (...a) => console.log("[hanako2dsh]", ...a),
  warn: (...a) => console.warn("[hanako2dsh]", ...a),
  error: (...a) => console.error("[hanako2dsh]", ...a),
};

if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[hanako2dsh] 代理端口不合法：${PORT}`);
  process.exit(2);
}

// 宿主会把受管运行时的 HOME 指向 <appData>/.runtime-tmp。
// DSH 按 ~/.dsh 找账号，不扳回来就永远是“未登录”。这一步必须在起桥之前做。
applyRealHome(log);

if (!(await isPortFree(PORT))) {
  console.error(`[hanako2dsh] 端口 ${PORT} 已被占用，无法起代理。请关掉占用它的程序后重启本 App。`);
  process.exit(3);
}

// 桥只用到 ctx 的这几个成员：config / dataDir / pluginDir / log / bus。
// bus 在 v2 运行时里没有宿主总线，定时任务的投递改由 App 侧轮询 outbox。
const shimCtx = {
  config: {},
  dataDir: DATA_DIR,
  pluginDir: INSTALL_DIR,
  log,
  bus: {
    request: async () => {
      throw new Error("受管运行时里没有宿主总线");
    },
  },
};

const bridge = new DshBridge(shimCtx);
bridge.proxyPort = PORT;

const shutdown = async (code = 0) => {
  try {
    await bridge.dispose();
  } catch (err) {
    log.warn(`dispose 失败：${err?.message || err}`);
  }
  process.exit(code);
};

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

try {
  await bridge.start();
} catch (err) {
  console.error(`[hanako2dsh] 启动失败：${err?.message || err}`);
  process.exit(1);
}

// 宿主要看到这一行精确的标记才认为服务可访问（service.readyMarker）。
console.log("HANAKO2DSH_READY");
log.info(`代理就绪 http://127.0.0.1:${bridge.proxyPort}/`);
