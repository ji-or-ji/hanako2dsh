/**
 * lib/outbox.js — 定时任务结果的投递收件箱。
 *
 * 定时派活跑在受管运行时里，那个进程没有宿主总线，发不了会话消息。
 * 所以运行时把要投递的结果写成文件（/__api/outbox），App 进程定时来拉，
 * 用 sdk.sessions.send 发出去，再回来 ack。两个进程不共享内存，文件是唯一稳妥的交接点。
 */
const ATTEMPTS = new Map();
const MAX_ATTEMPTS = 3;

export function startOutboxPoller(sdk, client) {
  const timer = setInterval(() => void drain(sdk, client), 20000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function drain(sdk, client) {
  if (!client.running) return { delivered: 0 };
  let data;
  try {
    data = await client.get("/__api/outbox");
  } catch {
    return { delivered: 0 };
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return { delivered: 0 };

  const done = [];
  for (const item of items) {
    const key = String(item.id || "");
    if (!key) continue;
    const tries = (ATTEMPTS.get(key) || 0) + 1;
    try {
      if (item.mode === "new") {
        const created = await sdk.sessions.create({
          agentId: "hanako",
          cwd: item.cwd || undefined,
          ownerPluginId: "hanako2dsh",
        });
        const sessionPath = created?.sessionPath || created?.session?.path;
        if (!sessionPath) throw new Error("session:create 没给会话路径");
        await sdk.sessions.send({ sessionPath, text: item.text });
      } else if (item.sessionPath) {
        await sdk.sessions.send({ sessionPath: item.sessionPath, text: item.text });
      } else {
        throw new Error("没有目标会话");
      }
      done.push(key);
      ATTEMPTS.delete(key);
    } catch (err) {
      ATTEMPTS.set(key, tries);
      if (tries >= MAX_ATTEMPTS) {
        done.push(key);
        ATTEMPTS.delete(key);
        await sdk.logger.warn(`定时结果投递放弃（${item.label || item.jobId || key}）：${err?.message || err}`);
      }
    }
  }

  if (done.length) {
    await client.post("/__api/outbox/ack", { ids: done }).catch(() => {});
  }
  return { delivered: done.length };
}
