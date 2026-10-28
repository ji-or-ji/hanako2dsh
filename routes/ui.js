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
  .wins { display: flex; flex-wrap: wrap; gap: 4px; max-height: 76px; overflow-y: auto;
    scrollbar-gutter: stable; }
  .wins:empty { display: none; }
  .wins::-webkit-scrollbar { width: 4px; height: 4px; }
  .wins::-webkit-scrollbar-track { background: transparent; }
  .wins::-webkit-scrollbar-thumb { background: rgba(128,128,128,.12); border-radius: 2px; transition: background .35s ease-out; }
  .wins:hover::-webkit-scrollbar-thumb,
  .wins.scrolling::-webkit-scrollbar-thumb { background: rgba(128,128,128,.45); }
  .wins::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  .whead { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #9ca3af;
    cursor: pointer; user-select: none; }
  .whead[hidden] { display: none; }
  .whead .wc { color: #6f6a61; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .win { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #f3f4f6; color: #6b7280;
    cursor: pointer; max-width: 150px; display: inline-flex; align-items: center; gap: 4px; }
  .win .wl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .win .wx { font-weight: 600; opacity: .3; font-size: 11px; line-height: 1; padding: 0 1px; }
  .win:hover .wx { opacity: .75; }
  .win .wx:hover { color: #dc2626; opacity: 1; }
  .whead .clr { margin-left: auto; font-size: 11px; color: #9ca3af; background: none; border: 0;
    padding: 0 2px; cursor: pointer; }
  .whead .clr:hover { color: #dc2626; }
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
  .theme { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
    background: #f5f1e9; border: 1px solid #e2ddd3; font-size: 11px; color: #6f6a61; line-height: 1.4; }
  .theme[hidden] { display: none }
  .theme .t-txt { flex: 1 }
  .theme b { color: #2b2a26; font-weight: 600 }
  .theme .t-off { flex: none; border: 1px solid #cfc9bf; background: transparent; color: #8b867c;
    font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer; font-family: inherit; }
  .theme .t-off:hover { border-color: #a9a49a; color: #2b2a26 }
  @media (prefers-color-scheme: dark) {
    .card { color: #e5e7eb } .sub { color: #9ca3af } .tl-text { color: #d1d5db } .prog { color: #60a5fa }
    .btn-abort { background: transparent }
    .win { background: #374151; color: #9ca3af } .win.on { background: #312e81; color: #c7d2fe }
    .whead .wc { color: #9aa1a5 }
    .wins::-webkit-scrollbar-thumb { background: rgba(200,200,200,.1) }
    .wins:hover::-webkit-scrollbar-thumb,
    .wins.scrolling::-webkit-scrollbar-thumb { background: rgba(200,200,200,.42) }
    .theme { background: #45535d; border-color: #55646e; color: #9aa1a5 }
    .theme b { color: #dce6ec }
    .theme .t-off { border-color: #55646e; color: #9aa1a5 }
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
        `<span class="win${w.active ? " on" : ""}" data-key="${escapeHtml(w.key)}">` +
        `<span class="wl">${escapeHtml(w.label)}</span>` +
        `<b class="wx" data-x="${escapeHtml(w.key)}" title="从列表移除（不删会话）">×</b></span>`,
    )
    .join("");
}

/** 窗口头：多于一个窗口时才出现；折叠时把当前窗口名写在头上 */
function winsHead(st) {
  const list = st.windows;
  if (!Array.isArray(list) || list.length <= 1) return { hidden: true, text: "" };
  const active = list.find((w) => w.active);
  const collapsed = st.windowsCollapsed === true;
  return {
    hidden: false,
    text: `${collapsed ? "▸" : "▾"} 窗口 ${list.length}${collapsed && active ? " · " + active.label : ""}`,
  };
}

const SCHED_STYLES = `
  .sch { border-top: 1px solid rgba(128,128,128,.16); margin-top: 6px; padding-top: 6px;
    display: flex; flex-direction: column; gap: 4px; }
  .sch-hd { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #9ca3af; }
  .sch-hd i { font-style: normal; color: #6f6a61; }
  .sch-open { margin-left: auto; border: 0; background: none; color: #9ca3af; cursor: pointer; font-size: 13px; line-height: 1; }
  .sch-open:hover { color: #4b5563; }
  #schList { display: flex; flex-direction: column; gap: 3px; max-height: 96px; overflow-y: auto; }
  .srow { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; background: rgba(128,128,128,.08); }
  .srow.off { opacity: .5; }
  .srow .st { flex: 1; overflow: hidden; }
  .srow .st b { display: block; font-weight: 500; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow .st i { font-style: normal; font-size: 10px; color: #8b867c; }
  .srow button { border: 0; background: none; cursor: pointer; color: #9ca3af; font-size: 10px; padding: 0 2px; }
  .srow button:hover { color: #dc2626; }
  .sch-form { display: flex; flex-direction: column; gap: 4px; }
  .sch-form textarea, .sch-form select, .sch-form input { font: inherit; font-size: 11px; color: inherit;
    border: 1px solid rgba(128,128,128,.28); border-radius: 6px; background: #fff; padding: 3px 5px; min-width: 0; }
  .sch-form textarea { resize: vertical; min-height: 42px; }
  .frow { display: flex; gap: 4px; }
  .frow > * { flex: 1; min-width: 0; }
  .frow button { border: 1px solid rgba(128,128,128,.28); border-radius: 6px; background: #fff;
    padding: 3px 6px; cursor: pointer; font: inherit; font-size: 11px; }
  .msg { font-size: 10px; color: #b45309; min-height: 12px; }
  /* 任何带 hidden 的子元素都必须真的隐藏（否则 display:flex 会盖掉 UA 的 [hidden]） */
  .sch [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    .sch-hd { color: #9ca3af; }
    .sch-hd i { color: #d1d5db; }
    .sch-open { color: #9ca3af; }
    .sch-open:hover { color: #e5e7eb; }
    .srow { background: rgba(255,255,255,.07); }
    .srow .st i { color: #9aa1a5; }
    .srow button { color: #9aa1a5; }
    .srow button:hover { color: #f87171; }
    .sch-form textarea, .sch-form select, .sch-form input {
      background: #37424a; color: #e5e7eb; border-color: rgba(255,255,255,.18); color-scheme: dark; }
    .sch-form textarea::placeholder { color: #8b939a; }
    .frow button { background: #37424a; color: #e5e7eb; border-color: rgba(255,255,255,.18); }
    .frow button:hover { background: #435159; }
    .msg { color: #fbbf24; }
  }
`;

const SCHED_SCRIPT = `
    (function () {
      const SCH = BASE ? BASE + "/__sched" : "";
      const $ = (id) => document.getElementById(id);
      if (!$("schList") || !SCH) return;
      let schData = { jobs: [], sessions: [] };
      function cronOf() {
        const f = $("fFreq").value;
        const tm = ($("fTime").value || "09:00").split(":");
        const h = Number(tm[0]) || 0, m = Number(tm[1]) || 0;
        if (f === "hourly") return m + " * * * *";
        if (f === "custom") return $("fCron").value.trim();
        if (f === "weekly") return m + " " + h + " * * " + $("fDow").value;
        return m + " " + h + " * * *";
      }
      function renderList() {
        const box = $("schList");
        box.textContent = "";
        const jobs = schData.jobs || [];
        const cnt = $("schCount");
        if (cnt) cnt.textContent = jobs.length ? String(jobs.length) : "";
        if (!jobs.length) {
          const d = document.createElement("div"); d.className = "msg"; d.textContent = "还没有定时任务";
          box.append(d); return;
        }
        for (const j of jobs) {
          const row = document.createElement("div");
          row.className = "srow" + (j.enabled ? "" : " off");
          const st = document.createElement("div"); st.className = "st";
          const b = document.createElement("b"); b.textContent = j.label || j.task;
          const i = document.createElement("i");
          const dest = { none: "不发送", session: "发会话", new: "发新会话" }[j.deliver] || "";
          i.textContent = j.cron + " · " + (j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "已停用") + " · " + dest;
          st.append(b, i);
          const tg = document.createElement("button"); tg.textContent = j.enabled ? "停用" : "启用";
          tg.onclick = () => post({ action: "toggle", id: j.id, enabled: !j.enabled });
          const rm = document.createElement("button"); rm.textContent = "删";
          rm.onclick = () => post({ action: "remove", id: j.id });
          row.append(st, tg, rm);
          box.append(row);
        }
      }
      async function load() {
        try {
          const r = await fetch(SCH + "?_=" + Date.now(), { cache: "no-store" });
          schData = await r.json();
          renderList();
          const sel = $("fSess");
          sel.textContent = "";
          for (const s of schData.sessions || []) {
            const o = document.createElement("option");
            o.value = s.path; o.textContent = String(s.title).slice(0, 24);
            sel.append(o);
          }
          if (!(schData.sessions || []).length) {
            const o = document.createElement("option"); o.value = ""; o.textContent = "（没有可选会话）"; sel.append(o);
          }
        } catch (e) { $("fMsg").textContent = "读取失败：" + e.message; }
      }
      async function post(body) {
        try {
          const r = await fetch(SCH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const j = await r.json();
          $("fMsg").textContent = j.ok ? "" : (j.error || "操作失败");
          await load();
          return j;
        } catch (e) { $("fMsg").textContent = "请求失败：" + e.message; return { ok: false }; }
      }
      $("schOpen").onclick = () => {
        const f = $("schForm");
        f.hidden = !f.hidden;
        if (!f.hidden) load();
      };
      $("fCancel").onclick = () => { $("schForm").hidden = true; $("fMsg").textContent = ""; };
      $("fFreq").onchange = () => {
        const f = $("fFreq").value;
        $("fDow").hidden = f !== "weekly";
        $("fTime").hidden = f === "hourly" || f === "custom";
        $("fCron").hidden = f !== "custom";
      };
      $("fDeliver").onchange = () => { $("fSess").hidden = $("fDeliver").value !== "session"; };
      $("fSave").onclick = async () => {
        const task = $("fTask").value.trim();
        if (!task) { $("fMsg").textContent = "先写任务内容"; return; }
        const deliver = $("fDeliver").value;
        const body = { action: "add", cron: cronOf(), task, deliver };
        if (!body.cron) { $("fMsg").textContent = "频率没填对"; return; }
        if (deliver === "session") {
          const sp = $("fSess").value;
          if (!sp) { $("fMsg").textContent = "没有可选会话"; return; }
          body.sessionPath = sp;
        }
        const r = await post(body);
        if (r && r.ok) { $("fTask").value = ""; $("schForm").hidden = true; }
      };
      load();
    })();
`;

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
    const BASE = ${JSON.stringify(base)};
    // 心跳轮询：一旦进入派活或实例掉线，就把页面交给入口层（刷成提示页/引导页）
    const HB = BASE + "/__hb";
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
    WIDGET_STYLES + SCHED_STYLES,
    `<div class="card">
      <div class="hd"><span class="led ${v.led}" id="led"></span><span id="label">${escapeHtml(v.label)}</span></div>
      <div class="sub" id="sub">${escapeHtml(v.sub)}</div>
      <div class="whead" id="whead"${winsHead(st).hidden ? " hidden" : ""}><span id="wheadText">${escapeHtml(winsHead(st).text)}</span><button class="clr" id="winsClear" title="清空列表（不删会话）">清空</button></div>
      <div class="wins" id="wins"${st.windowsCollapsed === true ? " hidden" : ""}>${winsRows(st.windows)}</div>
      <div class="prog" id="prog">${escapeHtml(st.progress?.text || "")}</div>
      <div class="theme" id="theme"${st.theme?.hint ? "" : " hidden"}>
        <span class="t-txt">Hanako 皮肤已就绪 · 在 DSH 的「外观」里选 <b>HanaAgent</b></span>
        <button class="t-off" id="themeOff" title="不再提示">不再提示</button>
      </div>
      <div class="tl" id="tl">${tlRows(st.timeline)}</div>
      <div class="sch">
        <div class="sch-hd"><span>定时</span><i id="schCount"></i><button class="sch-open" id="schOpen" title="新建定时任务">＋</button></div>
        <div id="schList"></div>
        <div class="sch-form" id="schForm" hidden>
          <textarea id="fTask" placeholder="要交给 DSH 的任务…"></textarea>
          <div class="frow">
            <select id="fFreq">
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="hourly">每小时</option>
              <option value="custom">自定义</option>
            </select>
            <select id="fDow" hidden>
              <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option>
              <option value="4">周四</option><option value="5">周五</option><option value="6">周六</option>
              <option value="0">周日</option>
            </select>
            <input id="fTime" type="time" value="09:00">
            <input id="fCron" hidden placeholder="分 时 日 月 周">
          </div>
          <div class="frow">
            <select id="fDeliver">
              <option value="none">不发送</option>
              <option value="session">发到指定会话</option>
              <option value="new">发到新会话</option>
            </select>
            <select id="fSess" hidden></select>
          </div>
          <div class="frow"><button id="fSave">保存</button><button id="fCancel">取消</button></div>
          <div class="msg" id="fMsg"></div>
        </div>
      </div>
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
    function renderWins(list, collapsed) {
      const head = el("whead"), headText = el("wheadText"), box = el("wins");
      if (!head || !box) return;
      const many = Array.isArray(list) && list.length > 1;
      head.hidden = !many;
      if (many) {
        const active = list.find(function (w) { return w.active; });
        headText.textContent = (collapsed ? "\u25B8" : "\u25BE") + " 窗口 " + list.length + (collapsed && active ? " · " + active.label : "");
      }
      box.hidden = !!collapsed;
      box.textContent = "";
      if (!many || collapsed) return;
      for (const w of list) {
        const s = document.createElement("span");
        s.className = "win" + (w.active ? " on" : "");
        const lab = document.createElement("span"); lab.className = "wl"; lab.textContent = w.label;
        const x = document.createElement("b"); x.className = "wx"; x.textContent = "×"; x.title = "从列表移除（不删会话）";
        x.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (!CTL) return;
          fetch(CTL + "?action=win_hide&key=" + encodeURIComponent(w.key) + "&_=" + Date.now(), { cache: "no-store" })
            .then(function () { poll(); }).catch(function () {});
        });
        s.append(lab, x);
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
    el("whead").addEventListener("click", function () {
      if (!CTL) return;
      fetch(CTL + "?action=windows_toggle&_=" + Date.now(), { cache: "no-store" })
        .then(function () { poll(); }).catch(function () {});
    });
    el("winsClear").addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (!CTL) return;
      fetch(CTL + "?action=wins_clear&_=" + Date.now(), { cache: "no-store" })
        .then(function () { poll(); }).catch(function () {});
    });
    (function () {
      const box = el("wins");
      if (!box || !box.addEventListener) return;
      let t = null;
      box.addEventListener("scroll", function () {
        box.classList.add("scrolling");
        if (t) clearTimeout(t);
        t = setTimeout(function () { box.classList.remove("scrolling"); }, 700);
      }, { passive: true });
    })();
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
    el("themeOff").addEventListener("click", async () => {
      if (!CTL) return;
      el("theme").hidden = true;
      try { await fetch(CTL + "?action=theme_hint_off&_=" + Date.now(), { cache: "no-store" }); } catch (e) {}
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
        if (s.theme) el("theme").hidden = !s.theme.hint;
        if (!aborting) el("abort").disabled = !s.running;
        renderWins(s.windows, s.windowsCollapsed === true);
        renderTimeline(s.timeline);
      } catch (e) { if (++miss > 4) { location.reload(); return; } }
      setTimeout(poll, 1500);
    }
    setTimeout(poll, 500);
    ${SCHED_SCRIPT}
    `,
  );
}
