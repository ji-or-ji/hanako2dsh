/**
 * routes/ui.js — 页面外壳、Widget 状态卡与心跳接口
 *
 * page  ：把 DSH 的代理地址（同源）嵌进一个内层 iframe，整页铺满
 * widget：不嵌界面，只显示大肥鱼的状态卡（在线 / 唤醒中 / 交流中 / 出错）
 * /state：JSON 快照
 *
 * 说明：
 * - Hana 的插件 iframe 内不能随意 fetch 本插件路由（会 403），所以
 *   page 用 location.reload() 轮询，widget 用代理上的 /__hb（跨源放开）轮询。
 * - 高度一律用 position:fixed + inset:0 贴住视口四边，不依赖父容器高度，
 *   避免出现"只占上半截、下面全空"的挤压。
 */

import { getBridge } from "../lib/bridge.js";

export default function registerUiRoutes(app, ctx) {
  app.get("/page", (c) => c.html(renderPage(ctx)));
  app.get("/widget", (c) => c.html(renderWidget(ctx)));
  app.get("/state", (c) => c.json(getBridge(ctx).getState()));
}

const HANA_READY =
  'window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "hana.ready" }, "*");';

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function doc(surface, styles, inner, script) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: transparent; }
  * { box-sizing: border-box; }
  ${styles}
</style></head>
<body data-surface="${surface}">
${inner}
<script type="module">
  ${HANA_READY}
  ${script}
</script>
</body></html>`;
}

const PAGE_STYLES = `
  #frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
  .center { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    flex-direction: column; gap: 10px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #6b7280; font-size: 14px; letter-spacing: .02em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; animation: pulse 1.2s ease-in-out infinite; }
  .row { display: flex; align-items: center; gap: 8px; }
  .small { font-size: 11px; opacity: .65; }
  @keyframes pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  .waves span { display: inline-block; animation: bounce 1.2s infinite; }
  .waves span:nth-child(2) { animation-delay: .15s }
  .waves span:nth-child(3) { animation-delay: .3s }
  @keyframes bounce { 0%,60%,100% { transform: translateY(0); opacity: .35 } 30% { transform: translateY(-3px); opacity: 1 } }
  b.who { color: #111827; font-weight: 600; margin: 0 5px; }
  @media (prefers-color-scheme: dark) { .center { color: #9ca3af } b.who { color: #f3f4f6 } }
`;

const WIDGET_STYLES = `
  .card { position: fixed; inset: 0; display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px 46px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #374151; }
  .hd { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .led { width: 9px; height: 9px; border-radius: 50%; background: #9ca3af; flex: none; }
  .led.ok { background: #22c55e }
  .led.warn { background: #f59e0b; animation: pulse 1.2s ease-in-out infinite }
  .led.busy { background: #3b82f6; animation: pulse 1.2s ease-in-out infinite }
  .led.bad { background: #ef4444 }
  @keyframes pulse { 0%,100% { opacity: .4 } 50% { opacity: 1 } }
  .sub { font-size: 12px; color: #6b7280; }
  .wins { display: flex; flex-wrap: wrap; gap: 4px; }
  .wins:empty { display: none; }
  .win { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #f3f4f6; color: #6b7280;
    cursor: pointer; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .win.on { background: #e0e7ff; color: #4338ca; cursor: default; }
  .prog { font-size: 12px; color: #3b82f6; line-height: 1.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prog:empty { display: none; }
  .tl { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; font-size: 12px;
    scrollbar-gutter: stable; }
  .tl::-webkit-scrollbar { width: 4px; height: 4px; }
  .tl::-webkit-scrollbar-track { background: transparent; }
  .tl::-webkit-scrollbar-thumb { background: rgba(128,128,128,.12); border-radius: 2px;
    transition: background .35s ease-out; }
  .tl:hover::-webkit-scrollbar-thumb { background: rgba(128,128,128,.3); }
  .tl.scrolling::-webkit-scrollbar-thumb { background: rgba(128,128,128,.55); }
  .tl::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  .tl-item { display: flex; align-items: baseline; gap: 6px; line-height: 1.45; }
  .tl-time { flex: none; color: #9ca3af; font-size: 10px; font-variant-numeric: tabular-nums; }
  .tl-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #9ca3af; position: relative; top: -1px; }
  .tl-item.start .tl-dot { background: #6366f1 }
  .tl-item.tool .tl-dot { background: #3b82f6 }
  .tl-item.done .tl-dot { background: #22c55e }
  .tl-item.fail .tl-dot { background: #ef4444 }
  .tl-text { flex: 1; word-break: break-word; color: #4b5563; }
  .tl-empty { color: #9ca3af; font-size: 12px; }
  .btn-abort { position: absolute; right: 12px; bottom: 10px; padding: 5px 14px; border-radius: 999px;
    border: 1px solid #ef4444; background: #fff; color: #ef4444; font-size: 12px; cursor: pointer;
    font-family: inherit; transition: background .15s ease, color .15s ease; }
  .btn-abort:hover { background: #ef4444; color: #fff }
  .btn-abort:disabled { opacity: .4; cursor: default }
  @media (prefers-color-scheme: dark) {
    .card { color: #e5e7eb } .sub { color: #9ca3af } .tl-text { color: #d1d5db } .prog { color: #60a5fa }
    .btn-abort { background: transparent }
    .win { background: #374151; color: #9ca3af } .win.on { background: #312e81; color: #c7d2fe }
    .tl::-webkit-scrollbar-thumb { background: rgba(200,200,200,.1) }
    .tl:hover::-webkit-scrollbar-thumb { background: rgba(200,200,200,.26) }
    .tl.scrolling::-webkit-scrollbar-thumb { background: rgba(200,200,200,.45) }
  }
`;

function statusView(s, { short = false } = {}) {
  if (s.chatting) {
    return { led: "busy", label: "正在和大肥鱼交流…", sub: `${s.chatAgent || "Hanako"} 派活中` };
  }
  switch (s.status) {
    case "ready":
      return { led: "ok", label: "大肥鱼在线", sub: short ? "可直接派活" : "已连接，可直接派活" };
    case "starting":
      return { led: "warn", label: "正在唤醒大肥鱼…", sub: "拉起实例并登录" };
    case "error":
      return { led: "bad", label: "连接出错", sub: s.lastError || "查看诊断" };
    case "stopped":
    case "idle":
    default:
      return { led: "off", label: "大肥鱼未启动", sub: "打开页面即可唤醒" };
  }
}

function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return Math.max(1, Math.round(d / 1000)) + "s";
  if (d < 3600000) return Math.round(d / 60000) + "m";
  return Math.round(d / 3600000) + "h";
}

function taskRows(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list
    .slice(0, 6)
    .map(
      (t) =>
        `<div class="task"><span class="st ${escapeHtml(t.status || "")}"></span>` +
        `<span class="lb">${escapeHtml(t.label || t.opId || "")}</span>` +
        `<span class="tm">${relTime(t.at)}</span></div>`,
    )
    .join("");
}

function tlRows(list) {
  if (!Array.isArray(list) || !list.length) return '<div class="tl-empty">暂无派活记录</div>';
  const p = (n) => String(n).padStart(2, "0");
  return list
    .slice(-40)
    .map((it) => {
      const d = new Date(it.ts || Date.now());
      const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      return (
        `<div class="tl-item ${escapeHtml(it.kind || "")}"><span class="tl-time">${t}</span>` +
        `<span class="tl-dot"></span><span class="tl-text">${escapeHtml(it.text || "")}</span></div>`
      );
    })
    .join("");
}

function winsRows(list) {
  if (!Array.isArray(list) || list.length <= 1) return "";
  return list
    .map(
      (w) =>
        `<span class="win${w.active ? " on" : ""}" data-key="${escapeHtml(w.key)}">${escapeHtml(w.label)}</span>`,
    )
    .join("");
}

function renderPage(ctx) {
  const bridge = getBridge(ctx);
  const st = bridge.getState();
  if (st.chatting) {
    const who = escapeHtml(st.chatAgent || "Hanako");
    return doc(
      "page",
      PAGE_STYLES,
      `<div class="center"><div><b class="who">${who}</b>正在和大肥鱼交流<span class="waves"><span>.</span><span>.</span><span>.</span></span></div>${st.progress?.text ? `<div class="small">${escapeHtml(st.progress.text)}</div>` : ""}</div>`,
      `setTimeout(() => location.reload(), 1500);`,
    );
  }
  if (st.status === "idle" || st.status === "stopped") void bridge.start();
  if (!st.ready || !st.proxyPort) {
    const why =
      st.status === "error" && st.lastError ? escapeHtml(st.lastError) : "正在拉起 DSH 实例并登录…";
    const reload = st.status !== "stopped";
    return doc(
      "page",
      PAGE_STYLES,
      `<div class="center">
        <div class="row"><span class="dot"></span><span>${why}</span></div>
        <div class="small">状态：${escapeHtml(String(st.status))}</div>
      </div>`,
      reload ? `setTimeout(() => location.reload(), 2500);` : "",
    );
  }
  const proxyUrl = `http://127.0.0.1:${st.proxyPort}/`;
  const base = `http://127.0.0.1:${st.proxyPort}`;
  return doc(
    "page",
    PAGE_STYLES,
    `<iframe id="frame" src="${proxyUrl}" allow="clipboard-read; clipboard-write"></iframe>`,
    `
    // 心跳轮询：一旦进入派活或实例掉线，就把页面交给入口层（刷成提示页/引导页）
    const HB = ${JSON.stringify(base)} + "/__hb";
    let alive = true;
    window.addEventListener("beforeunload", () => { alive = false; });
    async function poll() {
      if (!alive) return;
      try {
        const r = await fetch(HB + "?_=" + Date.now(), { cache: "no-store" });
        const s = await r.json();
        if (s.chatting || !s.ready) { location.reload(); return; }
      } catch (e) { /* 代理暂时不可达，继续等 */ }
      setTimeout(poll, 1000);
    }
    setTimeout(poll, 800);
    `,
  );
}

function renderWidget(ctx) {
  const bridge = getBridge(ctx);
  const st = bridge.getState();
  if (st.status === "idle" || st.status === "stopped") void bridge.start();
  const v = statusView(st, { short: true });
  const base = st.proxyPort ? `http://127.0.0.1:${st.proxyPort}` : "";
  return doc(
    "widget",
    WIDGET_STYLES,
    `<div class="card">
      <div class="hd"><span class="led ${v.led}" id="led"></span><span id="label">${escapeHtml(v.label)}</span></div>
      <div class="sub" id="sub">${escapeHtml(v.sub)}</div>
      <div class="wins" id="wins">${winsRows(st.windows)}</div>
      <div class="prog" id="prog">${escapeHtml(st.progress?.text || "")}</div>
      <div class="tl" id="tl">${tlRows(st.timeline)}</div>
      <button class="btn-abort" id="abort" disabled>急停</button>
    </div>`,
    `
    const BASE = ${JSON.stringify(base)};
    const HB = BASE ? BASE + "/__hb" : "";
    const CTL = BASE ? BASE + "/__ctl" : "";
    const el = (id) => document.getElementById(id);
    let miss = 0, aborting = false;
    function pad(n) { return String(n).padStart(2, "0"); }
    function fmt(ts) { const d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }
    function view(s) {
      if (s.chatting) return { led: "busy", label: "正在和大肥鱼交流…", sub: (s.chatAgent || "Hanako") + " 派活中" };
      if (s.status === "ready") return { led: "ok", label: "大肥鱼在线", sub: "可直接派活" };
      if (s.status === "starting") return { led: "warn", label: "正在唤醒大肥鱼…", sub: "拉起实例并登录" };
      if (s.status === "error") return { led: "bad", label: "连接出错", sub: s.lastError || "查看诊断" };
      return { led: "off", label: "大肥鱼未启动", sub: "打开页面即可唤醒" };
    }
    function renderTimeline(list) {
      const box = el("tl");
      if (!box) return;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.textContent = "";
      if (!Array.isArray(list) || !list.length) {
        const e = document.createElement("div"); e.className = "tl-empty"; e.textContent = "暂无派活记录"; box.append(e); return;
      }
      for (const it of list) {
        const row = document.createElement("div"); row.className = "tl-item " + (it.kind || "");
        const tm = document.createElement("span"); tm.className = "tl-time"; tm.textContent = fmt(it.ts || Date.now());
        const dot = document.createElement("span"); dot.className = "tl-dot";
        const tx = document.createElement("span"); tx.className = "tl-text"; tx.textContent = it.text || "";
        row.append(tm, dot, tx); box.append(row);
      }
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    function renderWins(list) {
      const box = el("wins");
      if (!box) return;
      box.textContent = "";
      if (!Array.isArray(list) || list.length <= 1) return;
      for (const w of list) {
        const s = document.createElement("span");
        s.className = "win" + (w.active ? " on" : "");
        s.textContent = w.label;
        s.title = w.key;
        (function (win) {
          s.addEventListener("click", function () {
            if (!CTL || win.active) return;
            fetch(CTL + "?action=focus&key=" + encodeURIComponent(win.key) + "&_=" + Date.now(), { cache: "no-store" })
              .then(function () { poll(); }).catch(function () {});
          });
        })(w);
        box.append(s);
      }
    }
    // 滚动时短暂显色（对齐 Hana 原生：平时隐藏，滚起来才现，滚完淡回去）
    (function () {
      const box = el("tl");
      if (!box || !box.addEventListener) return;
      let t = null;
      box.addEventListener("scroll", function () {
        box.classList.add("scrolling");
        if (t) clearTimeout(t);
        t = setTimeout(function () { box.classList.remove("scrolling"); }, 700);
      }, { passive: true });
    })();
    el("abort").addEventListener("click", async () => {
      if (!CTL || aborting) return;
      aborting = true; el("abort").disabled = true; el("abort").textContent = "急停中…";
      try { await fetch(CTL + "?action=abort&_=" + Date.now(), { cache: "no-store" }); } catch (e) {}
      setTimeout(() => { aborting = false; el("abort").disabled = false; el("abort").textContent = "急停"; }, 1500);
    });
    async function poll() {
      if (!HB) { if (++miss > 3) { location.reload(); return; } setTimeout(poll, 2500); return; }
      try {
        const r = await fetch(HB + "?_=" + Date.now(), { cache: "no-store" });
        const s = await r.json();
        miss = 0;
        const v = view(s);
        el("led").className = "led " + v.led;
        el("label").textContent = v.label;
        el("sub").textContent = v.sub;
        el("prog").textContent = s.progress || "";
        if (!aborting) el("abort").disabled = !s.running;
        renderWins(s.windows);
        renderTimeline(s.timeline);
      } catch (e) { if (++miss > 4) { location.reload(); return; } }
      setTimeout(poll, 1500);
    }
    setTimeout(poll, 500);
    `,
  );
}
