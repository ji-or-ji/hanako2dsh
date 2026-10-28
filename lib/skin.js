/**
 * lib/skin.js — 接管皮肤：把主题卡里的 token 注入镜像页
 *
 * 为什么不靠 dsh-themes：0.2.1 起那个插件在 DSH 0.2.1-rc.x 上注册不了路由，
 * 前端拿不到主题库就退回默认配色。而镜像页本来就由我们代理，直接注入最稳。
 *
 * 关键点：DSH 把主题变量写在 <body> 的内联 style 上（内联优先级高于普通样式表），
 * 所以要压过它必须用 body 选择器 + !important。深色态 DSH 会在 body 上加
 * data-ds-dark-theme 属性，用它做更高优先级的覆盖。
 */

export const DARK_SELECTOR = "body[data-ds-dark-theme]";

function declBlock(tokens) {
  const lines = [];
  for (const [key, raw] of Object.entries(tokens || {})) {
    if (!key.startsWith("--")) continue;
    const value = String(raw).replace(/[;{}<>]/g, "").trim();
    if (!value) continue;
    lines.push(`  ${key}: ${value} !important;`);
  }
  return lines.join("\n");
}

/** 由主题卡对象生成注入用的 CSS；浅色挂 body，深色挂 body[data-ds-dark-theme] */
export function buildSkinCss(theme) {
  const parts = [];
  const light = declBlock(theme?.light);
  if (light) parts.push(`body {\n${light}\n}`);
  const dark = declBlock(theme?.dark);
  if (dark) parts.push(`${DARK_SELECTOR} {\n${dark}\n}`);
  return parts.join("\n");
}

/** 把一段 CSS 插进 HTML（优先插在 </head> 前） */
export function injectSkin(html, css) {
  if (!css || typeof html !== "string") return html;
  if (html.includes('id="hana-skin"')) return html;
  const tag = `<style id="hana-skin">\n${css}\n</style>`;
  const head = html.search(/<\/head>/i);
  if (head >= 0) return html.slice(0, head) + tag + "\n" + html.slice(head);
  const body = html.search(/<body[^>]*>/i);
  if (body >= 0) {
    const end = html.indexOf(">", body) + 1;
    return html.slice(0, end) + tag + html.slice(end);
  }
  return tag + html;
}
