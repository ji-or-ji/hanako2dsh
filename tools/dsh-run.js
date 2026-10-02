import { getBridge } from "../lib/bridge.js";

export const name = "run";
export const description =
  "向 DeepSeek Harness 派一个 headless 任务（复用 DSH 账号登录），返回结构化结果。首次派活会返回 sessionId，后续同一工程可带 sessionId 复用上下文。";
export const parameters = {
  type: "object",
  properties: {
    task: { type: "string", description: "要交给 DSH 执行的任务描述" },
    cwd: { type: "string", description: "任务工作目录，留空用插件默认值" },
    sessionId: { type: "string", description: "复用已有会话时传入；不传则开新会话" },
    timeoutMs: { type: "number", description: "超时毫秒，默认 600000" },
    wait: {
      type: "boolean",
      description:
        "true = 同步等待最终结果（会阻塞当前回合）；默认 false = 异步，工具立即返回“已派单”，完成后结果自动回到对话",
    },
    permission: {
      type: "string",
      enum: ["read-only", "workspace-write", "danger-full-access"],
      description:
        "本次派活的权限等级（覆盖插件默认）。danger-full-access = 全程免审批、可越界操作；workspace-write = 只能改工作区，越界直接被拒；read-only = 只读",
    },
  },
  required: ["task"],
};
export const sessionPermission = { kind: "external_side_effect" };

function prettifyName(s) {
  if (!s) return "";
  if (/^[a-z][a-z0-9_-]*$/.test(s)) return s[0].toUpperCase() + s.slice(1);
  return s;
}

function pickAgentName(c) {
  if (!c) return "";
  const raw =
    c.agentName ||
    c.agentDisplayName ||
    (c.agent && (c.agent.name || c.agent.displayName)) ||
    c.agentId ||
    (c.agent && c.agent.id) ||
    "";
  return prettifyName(raw);
}

export async function execute(input, toolCtx) {
  const bridge = getBridge(toolCtx);
  const sessionPath = toolCtx?.sessionPath || toolCtx?.sessionRef?.sessionPath || null;
  const res = await bridge.runTask(input.task, {
    cwd: input.cwd,
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs,
    agentName: pickAgentName(toolCtx),
    sessionPath,
    defer: input.wait !== true,
    permission: input.permission,
  });
  const summary = {
    ok: res.ok,
    deferred: res.deferred || undefined,
    opId: res.opId,
    sessionId: res.sessionId,
    reason: res.reason,
    exitCode: res.code,
    usage: res.usage,
    text: res.text,
    stderr: res.ok ? undefined : res.stderr,
  };
  return JSON.stringify(summary, null, 2);
}
