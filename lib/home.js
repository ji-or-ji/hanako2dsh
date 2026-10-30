/**
 * lib/home.js — 把受管运行时的「家」改回真实用户档案。
 *
 * 宿主起受管运行时会在数据目录里造一份临时档案（`<appData>/.runtime-tmp`），
 * 把 HOME / USERPROFILE / APPDATA 全指过去。对一般程序没问题，对 DSH 是致命的：
 * 它按 `~/.dsh` 找账号，于是在临时档案里开出一份全新的 `.dsh`（161 字节的空凭据），
 * 页面就停在「登录 DeepSeek 账号」，用户会以为自己被登出了。
 *
 * 这里做两件事：
 *   1. 找出用户真正的档案目录（带 `.dsh` 且最好带凭据的那个）；
 *   2. 在进程里把 HOME / USERPROFILE / APPDATA / LOCALAPPDATA / DSH_HOME 改回去，
 *      之后 spawn 出去的 DSH 继承同一份环境，登录态就回来了。
 *
 * 找不到就不动，保持宿主给的沙箱档案——宁可还是没登录，也不要把别的目录认成用户家。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const SKIP_USERS = new Set(["Public", "Default", "Default User", "All Users", "defaultuser0"]);

function hasCredentials(home) {
  try {
    return existsSync(join(home, ".dsh", ".credentials.yaml"));
  } catch {
    return false;
  }
}

function hasDsh(home) {
  try {
    return existsSync(join(home, ".dsh"));
  } catch {
    return false;
  }
}

/** 候选真实档案目录，按「像用户家」的程度排序 */
export function homeCandidates({ platform = process.platform, env = process.env } = {}) {
  const list = [];
  if (platform === "win32") {
    if (env.USERNAME) list.push(`C:\\Users\\${env.USERNAME}`);
    if (env.HOMEDRIVE && env.HOMEPATH) list.push(`${env.HOMEDRIVE}${env.HOMEPATH}`);
    try {
      for (const name of readdirSync("C:\\Users")) {
        if (SKIP_USERS.has(name)) continue;
        list.push(join("C:\\Users", name));
      }
    } catch {
      /* 列不出来就算了 */
    }
  } else {
    if (env.HOME) list.push(env.HOME);
    if (env.USER) list.push(`/home/${env.USER}`);
  }
  return [...new Set(list.filter(Boolean))];
}

/** 返回最像真实档案的目录；都不像就返回 null */
export function resolveRealHome(options = {}) {
  const candidates = homeCandidates(options);
  const withCredentials = candidates.find(hasCredentials);
  if (withCredentials) return withCredentials;
  return candidates.find(hasDsh) || null;
}

/**
 * 改回真实档案。返回 { changed, home, from }。
 * log 只用来解释发生了什么，不输出任何凭据内容。
 */
export function applyRealHome(log) {
  const from = os.homedir();
  const real = resolveRealHome();
  if (!real || real === from) return { changed: false, home: from };

  process.env.HOME = real;
  process.env.USERPROFILE = real;
  if (process.platform === "win32") {
    process.env.APPDATA = join(real, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(real, "AppData", "Local");
  }
  if (hasDsh(real)) process.env.DSH_HOME = join(real, ".dsh");

  log?.info?.(`运行时被安排的家目录是 ${from}，已改回真实档案 ${real}`);
  return { changed: true, home: real, from };
}
