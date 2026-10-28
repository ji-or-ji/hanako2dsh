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
  if (!c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // 日与周都不是 * 时，两者满足其一即可（cron 的常规语义）
  const dayOk = c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk;
  return dayOk;
}

/** 下一次触发时间（严格晚于 from，秒级归零） */
export function nextRun(expr, from = new Date()) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
