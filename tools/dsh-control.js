import { getBridge } from "../lib/bridge.js";

export const name = "control";
export const description =
  "控制 Hanako2DSH 的本地 web 实例与代理：start 拉起、stop 停止、restart 重启（换端口重新登录）。";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "stop", "restart"], description: "操作" },
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
  else return `未知操作: ${input.action}`;

  return JSON.stringify({ action: input.action, ...bridge.getState() }, null, 2);
}
