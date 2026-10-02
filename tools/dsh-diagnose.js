import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getBridge } from "../lib/bridge.js";

export const name = "diagnose";
export const description =
  "诊断 Hanako2DSH 环境：DSH 安装路径、asar 内 cli.js、账号凭据文件、当前实例与代理状态。启动失败时先跑这个。";
export const parameters = { type: "object", properties: {} };
export const sessionPermission = { readOnly: true };

export async function execute(_input, toolCtx) {
  const bridge = getBridge(toolCtx);
  const { appDir, hostExe, cliJs } = bridge.resolveSpec();
  const cred = join(homedir(), ".dsh", ".credentials.yaml");
  const cfg = bridge.getConfig();

  const checks = {
    appDir,
    hostExeExists: existsSync(hostExe),
    // 注意：cli.js 在 app.asar 内，普通 fs 看不见属正常现象，electron 运行时可读
    cliJsVisibleToFs: existsSync(cliJs),
    cliJsOnAsar: cliJs.includes("app.asar"),
    credentialsExists: existsSync(cred),
    nodeVersion: process.version,
    config: cfg,
    state: bridge.getState(),
  };
  return JSON.stringify(checks, null, 2);
}
