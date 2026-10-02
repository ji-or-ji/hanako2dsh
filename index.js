/**
 * index.js — hanako2dsh 生命周期入口
 *
 * onload 时按配置拉起 DSH web 实例并开启本地代理；
 * 卸载时释放子进程与代理端口。桥实例挂在 ctx 上，供 routes/tools 共享。
 */

import { getBridge } from "./lib/bridge.js";

export default class DshBridgePlugin {
  async onload() {
    const ctx = this.ctx;
    const bridge = getBridge(ctx);
    this.bridge = bridge;

    // 卸载时清理（进程 + 代理 + 定时器）
    this.register(() => {
      void bridge.dispose();
    });

    const cfg = bridge.getConfig();
    if (cfg.autoStart === false) {
      ctx.log.info("hanako2dsh: autoStart=false，跳过自动拉起");
      return;
    }
    try {
      await bridge.start();
      ctx.log.info("hanako2dsh: 已拉起 DSH 实例并开启代理");
    } catch (err) {
      ctx.log.error(`hanako2dsh: 启动失败 ${err.message}`);
    }
  }

  onunload() {
    try {
      void this.bridge?.dispose();
      this.ctx.log.info("hanako2dsh: 已卸载，进程与代理已释放");
    } catch { /* ignore */ }
  }
}
