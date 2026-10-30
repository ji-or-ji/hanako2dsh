/**
 * lib/tools.js — 五个工具，全部只是桥的薄客户端。
 *
 * 真正的活（spawn DSH、代理、读 ~/.dsh）都在受管运行时里，这里只负责：
 * 解析工作目录、把调用转成一条 HTTP、把结果翻译成模型看得懂的话。
 */

const ACTIONS = ["start", "stop", "restart", "pinCwd", "unpinCwd"];

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

function pretty(value) {
  return text(JSON.stringify(value, null, 2));
}

/**
 * 工作目录解析。
 *
 * v1 的 lib/cwd.js 会去读会话 jsonl 头和 agent 的 config.yaml，v2 的 AppHost 读不了
 * 这些路径，所以改问宿主：session:get 的快照里带 cwd。桌面目录那一档拿不到就跳过。
 */
async function resolveCwdFor(sdk, client, { explicit, sessionId, sessionPath }) {
  if (explicit && String(explicit).trim()) return { cwd: String(explicit).trim(), source: "explicit" };

  const cfg = client.readLocalConfig();
  const pins = cfg.sessionCwd && typeof cfg.sessionCwd === "object" ? cfg.sessionCwd : {};
  const key = sessionId || sessionPath;
  if (key && pins[key]) return { cwd: String(pins[key]), source: "session-pin" };

  if (sessionId || sessionPath) {
    try {
      const snapshot = await sdk.sessions.get({ sessionId, sessionPath });
      const cwd = snapshot?.cwd;
      if (typeof cwd === "string" && cwd.trim()) return { cwd: cwd.trim(), source: "session" };
    } catch {
      /* 拿不到就往下走 */
    }
  }

  if (cfg.defaultCwd && String(cfg.defaultCwd).trim()) {
    return { cwd: String(cfg.defaultCwd).trim(), source: "config" };
  }
  return { cwd: sdk.dataDir, source: "app-data" };
}

function summarize(res, cwd, source, opsOn) {
  return {
    ok: Boolean(res?.ok),
    opId: res?.opId,
    sessionId: res?.sessionId,
    reason: res?.reason,
    exitCode: res?.code,
    cwd,
    cwdSource: source,
    ops: opsOn ? "on" : "off",
    usage: res?.usage,
    text: res?.text,
    stderr: res?.ok ? undefined : res?.stderr,
  };
}

async function pollOp(client, opId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await client.get(`/__api/op?id=${encodeURIComponent(opId)}`);
    if (!data || data.ok === false) throw new Error(data?.error || "查不到这个 op");
    if (data.status !== "running") return data;
    if (Date.now() > deadline) return { status: "timeout", opId };
    await new Promise((r) => setTimeout(r, 4000));
  }
}

export async function registerTools(sdk, client) {
  // ── status ────────────────────────────────────────────────────────────
  await sdk.tools.register({
    name: "status",
    description:
      "查看 Hanako2DSH 当前状态：DSH web 实例端口、本地代理端口、是否已就绪、是否持有会话 cookie、进程 PID、最近错误。",
    parameters: { type: "object", properties: {} },
    sessionPermission: { readOnly: true },
    execute: async (args) => {
      const session = args?.context || {};
      const state = await client.get("/__api/state");
      const resolved = await resolveCwdFor(sdk, client, {
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
      });
      return pretty({ ...state, cwd: resolved.cwd, cwdSource: resolved.source });
    },
  });

  // ── diagnose ──────────────────────────────────────────────────────────
  await sdk.tools.register({
    name: "diagnose",
    description:
      "诊断 Hanako2DSH 环境：DSH 安装路径、asar 内 cli.js、账号凭据文件、当前实例与代理状态。启动失败时先跑这个。",
    parameters: { type: "object", properties: {} },
    sessionPermission: { readOnly: true },
    execute: async () => pretty(await client.get("/__api/diagnose")),
  });

  // ── control ───────────────────────────────────────────────────────────
  await sdk.tools.register({
    name: "control",
    description:
      "控制 Hanako2DSH：start 拉起 / stop 停止 / restart 重启；pinCwd、unpinCwd 设置或清除本会话的临时工作目录"
      + "（不跨会话，下次派活生效）。也可以顺手改 DSH 安装目录与自动拉起开关。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS, description: "操作" },
        cwd: { type: "string", description: "pinCwd 时要绑到本会话的目录；传空字符串等同 unpinCwd" },
        appDir: { type: "string", description: "可选：覆盖 DSH 安装目录并持久化" },
        autoStart: { type: "boolean", description: "可选：设置是否随 Hana 启动自动拉起" },
      },
      required: ["action"],
    },
    sessionPermission: { kind: "external_side_effect" },
    execute: async (args) => {
      const input = args || {};
      const session = args?.context || {};

      const settingPatch = {};
      if (typeof input.appDir === "string" && input.appDir) settingPatch.dshAppDir = input.appDir;
      if (typeof input.autoStart === "boolean") settingPatch.autoStart = input.autoStart;
      if (Object.keys(settingPatch).length) {
        try {
          await sdk.config.setMany(settingPatch);
        } catch (err) {
          return pretty({ ok: false, error: `保存设置失败：${err?.message || err}` });
        }
        client.writeLocalConfig(settingPatch);
      }

      let result = { ok: true };
      if (input.action === "start") {
        await client.ensure(true);
        result = await client.post("/__api/control", { action: "start" });
      } else if (input.action === "stop") {
        result = await client.post("/__api/control", { action: "stop" });
        await client.stopRuntime();
      } else if (input.action === "restart") {
        result = await client.post("/__api/control", { action: "restart" });
      } else if (input.action === "pinCwd" || input.action === "unpinCwd") {
        const key = session.sessionId || session.sessionPath;
        if (!key) return pretty({ ok: false, error: "拿不到当前会话标识，无法设置会话临时目录" });
        const cfg = client.readLocalConfig();
        const pins = { ...(cfg.sessionCwd || {}) };
        const value = String(input.cwd || "").trim();
        if (input.action === "unpinCwd" || !value) delete pins[key];
        else pins[key] = value;
        const keys = Object.keys(pins);
        if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete pins[k];
        client.writeLocalConfig({ sessionCwd: pins });
      } else {
        return pretty({ ok: false, error: `未知操作 ${input.action}` });
      }

      const resolved = await resolveCwdFor(sdk, client, {
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
      });
      const state = await client.get("/__api/state");
      return pretty({
        action: input.action,
        ...(result && result.ok !== undefined ? { bridge: { ok: result.ok, error: result.error } } : {}),
        ...state,
        cwd: resolved.cwd,
        cwdSource: resolved.source,
      });
    },
  });

  // ── run ───────────────────────────────────────────────────────────────
  await sdk.tools.register({
    name: "run",
    description:
      "向 DeepSeek Harness 派一个 headless 任务（复用 DSH 账号登录），返回结构化结果。"
      + "首次派活会返回 sessionId，后续同一工程可带 sessionId 复用上下文。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "要交给 DSH 执行的任务描述" },
        cwd: {
          type: "string",
          description: "本次派活的工作目录（一次性覆盖）。不传则依次回退：会话临时目录 → 本会话工作目录 → 默认目录",
        },
        sessionId: { type: "string", description: "复用已有会话时传入；不传则开新会话" },
        timeoutMs: { type: "number", description: "超时毫秒，默认 600000" },
        wait: {
          type: "boolean",
          description: "true = 同步等结果；默认 false = 异步，工具先返回“已派单”，完成后结果自动回到对话",
        },
        permission: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "本次派活的权限等级（覆盖 App 设置）",
        },
        ops: {
          type: "boolean",
          description: "本次派活是否加载 dsh-ops 工具（原生文件读写/检索 + bash）。默认 true；纯只读任务传 false 可省固定开销",
        },
      },
      required: ["task"],
    },
    sessionPermission: { kind: "external_side_effect" },
    execute: async (args) => {
      const input = args || {};
      const context = args?.context || {};
      const resolved = await resolveCwdFor(sdk, client, {
        explicit: input.cwd,
        sessionId: context.sessionId,
        sessionPath: context.sessionPath,
      });
      const timeoutMs = Number(input.timeoutMs) || 600000;
      const opsOn = input.ops !== false;

      const started = await client.post("/__api/run", {
        task: input.task,
        cwd: resolved.cwd,
        sessionId: input.sessionId,
        permission: input.permission,
        ops: opsOn,
        timeoutMs,
      });
      if (!started?.ok || !started.opId) {
        return pretty({ ok: false, error: started?.error || "桥拒绝了这个派活请求", cwd: resolved.cwd });
      }

      const opId = started.opId;

      // 同步模式：在工具里等完
      if (input.wait === true) {
        const done = await pollOp(client, opId, timeoutMs + 30000);
        if (done.status === "timeout") {
          return pretty({ ok: false, opId, cwd: resolved.cwd, reason: "timeout", error: "等待超时，任务可能还在跑" });
        }
        if (done.status === "failed") {
          return pretty({ ok: false, opId, cwd: resolved.cwd, reason: "failed", stderr: done.error });
        }
        return pretty(summarize(done.result, resolved.cwd, resolved.source, opsOn));
      }

      // 异步模式：宿主后台任务负责收尾并把结果投递回这次对话
      const token = context.callToken;
      if (!token) {
        return pretty({ ok: true, deferred: true, opId, cwd: resolved.cwd, note: "这个宿主没有给调用令牌，结果不会自动回话；稍后用 status 查" });
      }
      const task = await sdk.tasks.create({
        callToken: token,
        label: "DSH 派活",
        delivery: "next-step",
      });
      void (async () => {
        try {
          const done = await pollOp(client, opId, Math.max(timeoutMs, 3600000));
          if (done.status === "done") {
            const summary = summarize(done.result, resolved.cwd, resolved.source, opsOn);
            const body = summary.ok
              ? `${summary.text || "（DSH 没有输出正文）"}\n\n会话：${summary.sessionId || "未知"} · 目录：${summary.cwd}`
              : `派活失败：${summary.stderr || summary.reason || "未知原因"}`;
            await sdk.tasks.complete(task.taskId, { text: body });
          } else {
            await sdk.tasks.fail(task.taskId, done.status === "timeout" ? "DSH 派活超时未返回" : String(done.error || "未知错误"));
          }
        } catch (err) {
          await sdk.tasks.fail(task.taskId, String(err?.message || err)).catch(() => {});
        }
      })();

      return pretty({ ok: true, deferred: true, opId, taskId: task.taskId, cwd: resolved.cwd });
    },
  });

  // ── schedule ──────────────────────────────────────────────────────────
  await sdk.tools.register({
    name: "schedule",
    description:
      "创建/查看/删除 DSH 定时任务：按期（5 段 cron）派活给 DeepSeek Harness，跑完可按设定投递结果——"
      + "不发送、发到指定 Hana 会话、或发到新建的 Hana 会话。只在 Hana 运行期间生效。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove", "enable", "disable"], description: "操作" },
        cron: { type: "string", description: '5 段 cron（分 时 日 月 周），如 "0 9 * * 1" 表示每周一 9:00；kind=once 时忽略' },
        kind: { type: "string", enum: ["cron", "once"], description: "cron=周期任务（默认）；once=指定一次" },
        at: { type: "string", description: "kind=once 时的执行时间：ISO 字符串或毫秒时间戳" },
        task: { type: "string", description: "要派给 DSH 的任务内容" },
        label: { type: "string", description: "给人看的短标签，留空取任务前 40 字" },
        deliver: {
          type: "string",
          enum: ["none", "session", "new"],
          description: "结果去向：none 不发送 / session 发到指定会话（需同时给 sessionPath）/ new 发到新会话",
        },
        sessionPath: { type: "string", description: "deliver=session 时的目标 Hana 会话文件路径" },
        cwd: { type: "string", description: "派活工作目录，留空按默认链" },
        permission: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "本次派活的权限等级，留空用 App 设置",
        },
        id: { type: "string", description: "remove / enable / disable 时的任务 id" },
      },
      required: ["action"],
    },
    sessionPermission: { kind: "external_side_effect" },
    execute: async (args) => {
      const input = args || {};
      if (input.action === "list") {
        const data = await client.get("/__sched");
        return pretty(data);
      }
      if (input.action === "add") {
        const data = await client.post("/__sched", {
          action: "add",
          kind: input.kind,
          cron: input.cron,
          at: input.at,
          task: input.task,
          label: input.label,
          deliver: input.deliver || "none",
          sessionPath: input.sessionPath,
          cwd: input.cwd,
          permission: input.permission,
        });
        return pretty(data);
      }
      if (input.action === "remove") {
        return pretty(await client.post("/__sched", { action: "remove", id: input.id }));
      }
      if (input.action === "enable" || input.action === "disable") {
        return pretty(await client.post("/__sched", { action: "toggle", id: input.id, enabled: input.action === "enable" }));
      }
      return pretty({ ok: false, error: `未知操作 ${input.action}` });
    },
  });

  // ── wake（输入栏按钮用） ────────────────────────────────────────
  // 点一下只做两件事：确保受管运行时存在、把桥拉起来，然后回一句当前状态。
  await sdk.tools.register({
    name: "wake",
    description: "确保 DSH 在跑：运行时没起就拉起，桥停了就启起来，然后回一句当前状态。",
    parameters: { type: "object", properties: {} },
    sessionPermission: { kind: "external_side_effect" },
    execute: async () => {
      try {
        await client.ensure();
        const result = await client.post("/__api/control", { action: "start" });
        const state = result?.state || (await client.get("/__api/state"));
        const where = state?.proxyPort ? ` · 端口 ${state.proxyPort}` : "";
        const what = state?.ready ? "已就绪" : `启动中（${state?.status || "unknown"}）`;
        return text(`DSH ${what}${where}`);
      } catch (err) {
        return text(`DSH 没拉起来：${err?.message || err}`);
      }
    },
  });
}
