/**
 * index.js — Hanako2DSH v2 入口。
 *
 * 这里只做三件事：注册工具、按设置决定要不要自动拉起、把定时结果的收件箱扫起来。
 * DSH 的一切都在受管运行时（runtime/server.mjs）里，App 进程没有网络也没有 ~/.dsh。
 */
import { defineApp } from "./sdk/app-contract/server-client.js";
import { createBridgeClient } from "./lib/client.js";
import { registerTools } from "./lib/tools.js";
import { startOutboxPoller } from "./lib/outbox.js";

export default defineApp(async (sdk) => {
  const client = createBridgeClient(sdk);
  await registerTools(sdk, client);

  // 设置贡献要等 apply 落定才登记，等一会儿再读 autoStart。
  const kickoff = setTimeout(() => {
    void (async () => {
      try {
        const values = (await sdk.config.getAll()) || {};
        if (values.autoStart === false) {
          await sdk.logger.info("Hanako2DSH：autoStart=false，跳过自动拉起");
          return;
        }
        await client.ensure();
        await sdk.logger.info("Hanako2DSH：已拉起 DSH 实例并开启代理");
      } catch (err) {
        await sdk.logger.error(`Hanako2DSH 启动失败：${err?.message || err}`);
      }
    })();
  }, 3000);
  kickoff.unref?.();

  startOutboxPoller(sdk, client);

  await sdk.logger.info("Hanako2DSH 已加载");
});
