/**
 * lib/cron.js — 最小可用的 5 段 cron 匹配器（分 时 日 月 周）
 *
 * 支持：* / 数字 / a-b 区间 / a,b 列表 / *斜杠n 步进 / 区间步进 a-b/n
 * 周字段 0 和 7 都表示周日。不处理秒、不支持名称（mon、JAN）。
 */

function parseField(expr, min, max) {
  const out = new Set();
  for (const part of String(expr).split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    let step = 1;
    let body = seg;
    const slash = seg.indexOf("/");
    if (slash >= 0) {
      body = seg.slice(0, slash);
      step = Number(seg.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) throw new Error(`非法步进: ${seg}`);
    }
    let lo;
    let hi;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`非法区间: ${seg}`);
      lo = a;
      hi = b;
    } else {
      const n = Number(body);
      if (!Number.isInteger(n)) throw new Error(`非法值: ${seg}`);
      lo = n;
      hi = slash >= 0 ? max : n;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`越界: ${seg}（应 ${min}-${max}）`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new Error(`空字段: ${expr}`);
  return out;
}

/** 解析表达式；非法时抛错 */
export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 需要 5 段：分 时 日 月 周");
  const [mi, ho, dom, mon, dow] = parts;
  const dowSet = parseField(dow, 0, 7);
  if (dowSet.has(7)) dowSet.add(0);
  return {
    expr: parts.join(" "),
    minute: parseField(mi, 0, 59),
    hour: parseField(ho, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: dowSet,
    domStar: dom.trim() === "*",
    dowStar: dow.trim() === "*",
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getMinutes())) return false;
  if (!c.hour.has(d.getHours())) return false;
  return matchesDay(c, d);
}

/** 只比日期部分（日/月/周），供日级扫描用 */
function matchesDay(c, d) {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // 日与周都不是 * 时，两者满足其一即可（cron 的常规语义）
  return c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk;
}

/** 某一天里最早的允许时刻（日级扫描命中后用） */
function earliestOnDay(c, day) {
  const h = Math.min(...c.hour);
  const m = Math.min(...c.minute);
  const d = new Date(day.getTime());
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** 下一次触发时间（严格晚于 from，秒级归零）
 *
 * 先按分钟扫 maxDays 天（覆盖绝大多数表达式，快）；
 * 扫不到再降为按天扫最多 1900 天——这样「2 月 29 日」这类闰年日期
 * 能算出真正的那一天，而不是静默变成永不触发的任务。
 */
export function nextRun(expr, from = new Date(), maxDays = 370) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = Math.max(1, maxDays) * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  // 日级回退：跨闰年周期
  const day = new Date(from.getTime());
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  for (let i = 0; i < 1900; i++) {
    if (matchesDay(c, day)) return earliestOnDay(c, day);
    day.setDate(day.getDate() + 1);
  }
  return null;
}
