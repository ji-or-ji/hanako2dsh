/**
 * tools/dsh-schedule.js — 定时派活
 *
 * 像普通 agent 的「任务计划」那样创建一条 DSH 定时任务，并指定结果去向：
 *   deliver=none    跑完不发送（只留在侧栏时间线）
 *   deliver=session 发到指定 Hana 会话
 *   deliver=new     发到新建的 Hana 会话
 */

import { getBridge } from "../lib/bridge.js";

export const name = "schedule";
export const description =
  "创建/查看/删除 DSH 定时任务：按期（5 段 cron）派活给 DeepSeek Harness，跑完可按设定投递结果——不发送、发到指定 Hana 会话、或发到新建的 Hana 会话。只在 Hana 运行期间生效。";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["add", "list", "remove", "enable", "disable"], description: "操作" },
    cron: { type: "string", description: "5 段 cron（分 时 日 月 周），如 \"0 9 * * 1\" 表示每周一 9:00" },
    task: { type: "string", description: "要派给 DSH 的任务内容" },
    label: { type: "string", description: "给人看的短标签，留空取任务前 40 字" },
    deliver: {
      type: "string",
      enum: ["none", "session", "new"],
      description: "结果去向：none 不发送 / session 发到指定会话（需同时给 sessionPath）/ new 发到新会话",
    },
    sessionPath: { type: "string", description: "deliver=session 时的目标 Hana 会话文件路径" },
    cwd: { type: "string", description: "派活工作目录，留空按默认链（会话目录 → agent 桌面）" },
    permission: {
      type: "string",
      enum: ["read-only", "workspace-write", "danger-full-access"],
      description: "本次派活的权限等级，留空用插件设置",
    },
    id: { type: "string", description: "remove / enable / disable 时的任务 id" },
  },
  required: ["action"],
};

export const sessionPermission = { kind: "external_side_effect" };

export async function execute(input, toolCtx) {
  const bridge = getBridge(toolCtx);
  const api = bridge.scheduleApi();
  if (!api) return JSON.stringify({ ok: false, error: "定时派活器没起来" }, null, 2);

  if (input.action === "list") {
    return JSON.stringify({ ok: true, jobs: api.list() }, null, 2);
  }
  if (input.action === "add") {
    try {
      const job = api.add({
        cron: input.cron,
        task: input.task,
        label: input.label,
        deliver: input.deliver || "none",
        sessionPath: input.sessionPath,
        cwd: input.cwd,
        permission: input.permission,
      });
      return JSON.stringify({ ok: true, job }, null, 2);
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2);
    }
  }
  if (input.action === "remove") {
    return JSON.stringify({ ok: api.remove(input.id), id: input.id }, null, 2);
  }
  if (input.action === "enable" || input.action === "disable") {
    return JSON.stringify({ ok: api.setEnabled(input.id, input.action === "enable"), id: input.id }, null, 2);
  }
  return `未知操作: ${input.action}`;
}
