/**
 * lib/theme.js — Hanako 皮肤（dsh-themes 的 custom 主题条目）
 *
 * 设计原则（用户明确要求）：**只装上，不抢占**。
 *   - 把 `themes/hanaagent.json` 合并进 `~/.dsh/dsh-themes.json` 的 `custom[]`（按 id 匹配，只碰这一条）
 *   - 不修改 `current` / `mixed`：要切主题由用户在 DSH 的外观里自己点
 *   - 首次改动前留一份 `.bak`，便于回退
 *   - 检测不到 dsh-themes 时安静跳过
 */

import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

export const THEME_ID = "hanaagent";

function dshHome(override) {
  return override || process.env.DSH_HOME || join(os.homedir(), ".dsh");
}

export function themesFilePath(override) {
  return join(dshHome(override), "dsh-themes.json");
}

/** dsh-themes 插件在不在（看 themes 文件 或 任一 profile 里装了包） */
export function hasDshThemes(override) {
  if (existsSync(themesFilePath(override))) return true;
  const root = join(dshHome(override), "profiles");
  if (!existsSync(root)) return false;
  try {
    for (const p of ["web", "desktop", "headless"]) {
      if (existsSync(join(root, p, "node_modules", "dsh-themes"))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 读我们随插件带的主题定义 */
export function loadBundledTheme(pluginDir) {
  const f = join(pluginDir, "themes", `${THEME_ID}.json`);
  if (!existsSync(f)) return null;
  try {
    const t = JSON.parse(readFileSync(f, "utf-8"));
    return t && t.id ? t : null;
  } catch {
    return null;
  }
}

/** 当前生效的主题是不是我们这张卡 */
export function isThemeActive(override) {
  const f = themesFilePath(override);
  if (!existsSync(f)) return false;
  try {
    const j = JSON.parse(readFileSync(f, "utf-8"));
    if (j.current === THEME_ID) return true;
    const m = j.mixed;
    return !!(m && m.light === THEME_ID && m.dark === THEME_ID);
  } catch {
    return false;
  }
}

/**
 * 把主题合并进 dsh-themes.json。
 * 返回值：{ ok, changed, reason }
 */
export function ensureTheme(pluginDir, override) {
  if (!hasDshThemes(override)) return { ok: false, reason: "no-dsh-themes" };
  const theme = loadBundledTheme(pluginDir);
  if (!theme) return { ok: false, reason: "no-bundled-theme" };

  const file = themesFilePath(override);
  const want = { ...theme, imported: true };

  let doc;
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return { ok: false, reason: "themes-file-unreadable" };
    }
  } else {
    doc = { current: null, mixed: null, custom: [] };
  }
  if (!Array.isArray(doc.custom)) doc.custom = [];

  const idx = doc.custom.findIndex((t) => t && t.id === THEME_ID);
  if (idx >= 0 && JSON.stringify(doc.custom[idx]) === JSON.stringify(want)) {
    return { ok: true, changed: false, reason: "already-installed" };
  }

  if (existsSync(file)) {
    try { copyFileSync(file, `${file}.bak`); } catch { /* ignore */ }
  } else {
    try { mkdirSync(dirname(file), { recursive: true }); } catch { /* ignore */ }
  }

  if (idx >= 0) doc.custom[idx] = want;
  else doc.custom.push(want);

  try {
    writeFileSync(file, JSON.stringify(doc), "utf-8");
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  return { ok: true, changed: true, reason: idx >= 0 ? "updated" : "installed" };
}
