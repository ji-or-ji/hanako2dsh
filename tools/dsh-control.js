import { getBridge } from "../lib/bridge.js";
import { resolveCwd, hanaSessionKey } from "../lib/cwd.js";

export const name = "control";
export const description =
  "控制 Hanako2DSH：start 拉起 / stop 停止 / restart 重启；pinCwd、unpinCwd 设置或清除**本 Hana 会话**的临时工作目录（不跨会话，下次派活生效）。";
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "stop", "restart", "pinCwd", "unpinCwd"],
      description: "操作",
    },
    cwd: { type: "string", description: "pinCwd 时要绑到本会话的目录；传空字符串则等同 unpinCwd" },
    appDir: { type: "string", description: "可选：临时覆盖 DSH 安装目录并持久化" },
    autoStart: { type: "boolean", description: "可选：设置是否随 Hana 启动自动拉起" },
  },
  required: ["action"],
};
export const sessionPermission = { kind: "external_side_effect" };

export async function execute(input, toolCtx) {
  const bridge = getBridge(toolCtx);
  const patch = {};
  if (typeof input.appDir === "string" && input.appDir) patch.dshAppDir = input.appDir;
  if (typeof input.autoStart === "boolean") patch.autoStart = input.autoStart;
  if (Object.keys(patch).length) bridge.setConfig(patch);

  if (input.action === "start") await bridge.start();
  else if (input.action === "stop") await bridge.stop();
  else if (input.action === "restart") await bridge.restart();
  else if (input.action === "pinCwd" || input.action === "unpinCwd") {
    const key = hanaSessionKey(toolCtx);
    if (!key) {
      return JSON.stringify({ ok: false, error: "拿不到当前 Hana 会话标识，无法设置会话临时目录" }, null, 2);
    }
    const pins = { ...(bridge.getConfig().sessionCwd || {}) };
    const v = String(input.cwd || "").trim();
    if (input.action === "unpinCwd" || !v) delete pins[key];
    else pins[key] = v;
    const keys = Object.keys(pins);
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete pins[k];
    bridge.setConfig({ sessionCwd: pins });
  } else return `未知操作: ${input.action}`;

  const resolved = resolveCwd({
    sessionPath: toolCtx?.sessionPath || toolCtx?.sessionRef?.sessionPath,
    pinned: (bridge.getConfig().sessionCwd || {})[hanaSessionKey(toolCtx)],
    fallback: bridge.getConfig().defaultCwd,
  });

  return JSON.stringify(
    { action: input.action, ...bridge.getState(), cwd: resolved.cwd, cwdSource: resolved.source },
    null,
    2,
  );
}
