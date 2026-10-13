import { getBridge } from "../lib/bridge.js";
import { resolveCwd, hanaSessionKey } from "../lib/cwd.js";

export const name = "status";
export const description =
  "查看 Hanako2DSH 当前状态：DSH web 实例端口、本地代理端口、是否已就绪、是否持有会话 cookie、进程 PID、最近错误。";
export const parameters = { type: "object", properties: {} };
export const sessionPermission = { readOnly: true };

export async function execute(_input, toolCtx) {
  const bridge = getBridge(toolCtx);
  const cfg = bridge.getConfig();
  const resolved = resolveCwd({
    sessionPath: toolCtx?.sessionPath || toolCtx?.sessionRef?.sessionPath,
    pinned: (cfg.sessionCwd || {})[hanaSessionKey(toolCtx)],
    fallback: cfg.defaultCwd,
  });
  const st = bridge.getState();
  return JSON.stringify({ ...st, cwd: resolved.cwd, cwdSource: resolved.source }, null, 2);
}
