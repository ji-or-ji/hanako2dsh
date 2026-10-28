# Hanako2DSH

把本机那台 **DeepSeek Harness** 接进 Hana：**一个页签里看它干活，一句话把活派给它。**

---

## 先说清楚：这里的 DSH 是哪一个

本插件对接的是 **DeepSeek 官方开源的 DeepSeek Harness**（仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)），即官方桌面版 / CLI 那一套。

**不是**这些：第三方 AIO 或"整合包"式发行版、魔改桌面壳、手机移植版。那些会改动 profile 布局、默认端口与凭据路径，本插件**不做适配**，也别指望能直接用。

另外，它**不碰任何 API key**：凭据直接用你自己那份 DSH 已经登录好的（`~/.dsh/.credentials.yaml`），插件只是借它去登本地实例。

---

## 它能做什么

三件事，互不依赖，可以只用其中一件：

1. **镜像页签** —— 在 Hana 顶部开一个 `DSH` 页签。内层 iframe 连的是**本机真实运行的 DSH 界面**（插件在本地架一个反向代理，保持 Host、去掉 Origin、注入会话 cookie），HTTP 和 WebSocket 全透传。也就是说这是**活的**界面，不是截图；你在里面点、在里面聊，都作数。
2. **派活** —— `hanako2dsh_run` 把任务交给 DSH 的 headless 模式执行。默认**异步**：工具立刻返回「已派单」，任务在后台跑，**完成后结果自动回到对话**（走宿主的 deferred 通道，不用你在旁边守着）。想要同步等待就传 `wait: true`。

   派活默认**加载 `dsh-ops`**（如果 headless profile 里装了）：它的原生文件工具和 bash 在「写 → 跑 → 改」这类迭代任务里能省约 15% token。但它的固定开销（额外提示词 + 工具 schema）在**纯只读检索**任务里摊不薄，实测反而多花 10%~15%。所以只读活可以传 `ops: false` 关掉，能净省。没装 dsh-ops 时这个参数不产生任何影响。
3. **侧栏时间线** —— 窗格里按「**一次 DSH 会话 = 一个窗口**」分栏，实时列出每一次工具调用与每段输出（截前 200 字），带状态灯、实时进度、右下角**急停**。窗口历史会落盘，重启 Hana 不丢。窗口多于一个时顶部会出现**窗口标签**（点一下切窗口），**点它的标题即可折叠**（折叠后标题上就写着当前窗口名），状态会记住；展开时也限高 76px 可滚，不会把时间线挤没。

---

## 已适配的插件

Hana2DSH 不绑定任何 DSH 插件。下面这些是**实测过、并按它们的行为做过适配**的；没装的不会被读取，也不会影响派活。

| 插件 | 适配方式 | 默认 | 实测 / 说明 |
| --- | --- | --- | --- |
| `dsh-ops` | 派活时按需加载；`hanako2dsh_run` 的 `ops: false` 可关掉 | **开** | 原生文件工具 + 自带 bash（Windows 下可指向 Git Bash）。「写 → 跑 → 改」的迭代任务省约 15%；纯只读检索多花 10%~15%，所以默认开、只读活显式关 |
| `dsh-themes` | 只追加 Hanako 皮肤卡，不碰已有卡片、不改当前主题 | 自动 | 按 id 匹配，卡片已存在就完全不写；检测不到该插件时安静跳过 |

新增适配时请在这里登记，并写清楚**默认开还是关、什么场景下该换一边**。这一栏是给使用者的承诺，不是名录。

---

## 前置条件

| 条件 | 说明 |
| --- | --- |
| 系统 | **Windows**。代码里没有平台硬编码，但目前只在 Windows 实测过，macOS / Linux 未验证 |
| DSH | 本机已安装**官方 DSH 桌面版**（能跑起 `DeepSeek Harness.exe`），并且至少成功登录过一次 |
| Hana | ≥ `0.421.0` |

---

## 安装

1. 设置 → 插件 → 把 zip 拖进安装区（或从插件市场安装）
2. 打开「**允许全权插件**」。本插件需要 `full-access`：它要起本地反向代理、注册路由与生命周期钩子，这些在 restricted 下拿不到
3. 如果它找不到 DSH，去插件设置里把「**DSH 安装目录**」填成含 `DeepSeek Harness.exe` 的那个文件夹（留空时会自动探测几个常见位置）

---

## 权限与安全（建议先读这一段）

- **trust = `full-access`**。它会在本机 **spawn 一个 DSH 进程**、监听 `127.0.0.1` 上的临时端口、读取 DSH 的账号凭据用于本地登录。反向代理**只绑 `127.0.0.1`**，不对外网开放；会话 cookie 只活在插件进程内存里。
- **默认 `permissionMode = danger-full-access`**：DSH 侧**不再弹审批**，可以越界写文件。想收紧就改成：

  | 取值 | 含义 |
  | --- | --- |
  | `danger-full-access`（默认） | 全程免审批、可越界 |
  | `workspace-write` | 只能改工作目录，越界**直接被拒** |
  | `read-only` | 只读 |

  单次派活也可以用 `hanako2dsh_run` 的 `permission` 参数单独覆盖。
- 急着停手时，窗格右下角有**急停**按钮：中止当前派活，不动其他东西。

---

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dshAppDir` | 空 | DSH 安装目录（含 `DeepSeek Harness.exe`）。留空自动探测 |
| `autoStart` | `true` | Hana 启动时自动拉起实例并建代理；关掉则打开页签时才懒启动 |
| `defaultCwd` | 空 | 派活的兑底工作目录。**优先级很低**：只有在前面的显式参数、会话临时目录、会话目录、agent 桌面都拿不到时才用它 |
| `permissionMode` | `danger-full-access` | 权限等级，见上 |

---

## 工具

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `hanako2dsh_run` | external | 派活。默认异步，返回 `{ok, deferred, opId}`；`wait:true` 同步等结果。`ops:false` 让本次不加载 dsh-ops |
| `hanako2dsh_status` | readOnly | 实例端口 / 代理端口 / 是否就绪 / cookie / PID / 权限等级 / 时间线 |
| `hanako2dsh_control` | external | `start` / `stop` / `restart` |
| `hanako2dsh_diagnose` | readOnly | 体检：安装路径、asar 内 `cli.js`、账号凭据、当前状态 |

---

## 已知限制（照实说）

- **它是"派活账本"，不是"DSH 全貌"**。侧栏时间线只记**插件派出去的活**；你在 DSH 界面里手动跑的会话，不进这条线。你不派活，它就是空的。
- **别和桌面端 DSH 同时抢**。两者共用同一份账号目录（`~\.dsh`，凭据 / 会话 / 锁都在这），我们的实例可能起不来。插件对此有**指数退避 + 连续失败 5 次即停手**的保护，不会再无限重试拖垮机器。
- **headless 没有审批通道**。所以派活时的越界行为，要么被放行（`danger-full-access`），要么被拒（`workspace-write`），中间没有"问一下"这一步。
- **窗口 = 会话**。同一目录下开两个会话，就是两个窗口，这是设计如此。
- 反代依赖本地回环端口，若被安全软件拦截会表现为页签一直转圈（`hanako2dsh_diagnose` 能定位）。

---

## 工作目录（派活落在哪）

`hanako2dsh_run` 的 `cwd` 决定 DSH 在哪个目录里干活。不传时按下面这条链回退，第一条命中的赢：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `explicit` | 本次调用显式传的 `cwd` |
| 2 | `session-pin` | **本 Hana 会话**里临时指定的目录（见下） |
| 3 | `session` | 本 Hana 会话自身的工作目录（读会话文件头） |
| 4 | `desk` | agent 的桌面：`agents/<id>/config.yaml` 里的 `desk.home_folder` |
| 5 | `config` | 插件设置里的 `defaultCwd` |
| 6 | `process` | `HANA_WORKSPACE` 或进程 cwd |

每次派活的返回里都带 `cwd` 与 `cwdSource`，所以“它到底跑哪了”一看就知道。

**本会话临时目录**（只影响当前 Hana 会话，不跨会话）：

```
hanako2dsh_control { "action": "pinCwd", "cwd": "D:\\my-temp" }   ← 绑定到本会话
hanako2dsh_control { "action": "unpinCwd" }                       ← 解除（传空 cwd 同效）
```

绑定后，本会话后续的派活都落在那个目录，直到你解除或换个目录。

---

## Hanako 皮肤（可选）

插件里带一张自制的 DSH 主题卡 **`HanaAgent`**：暖米色浅色 + 石板蓝深色，支持深浅自动跟随，让镜像里的 DSH 看上去跟 Hana 是一家人。

| 浅色 | 深色 |
| --- | --- |
| ![浅色](https://raw.githubusercontent.com/ji-or-ji/hanako2dsh/main/docs/theme-light.png) | ![深色](https://raw.githubusercontent.com/ji-or-ji/hanako2dsh/main/docs/theme-dark.png) |

**做法（1.8.2 起）：由插件自己注入，不再依赖第三方**

DSH 把主题变量写在 `<body>` 的内联 `style` 上，内联优先级高于普通样式表，所以直接写 CSS 是压不过的 —— 我们注入的规则用 `body` + `!important`，并用 `body[data-ds-dark-theme]` 做深色覆盖。页面本来就由代理转发，所以这一步与 DSH 装了什么主题插件无关。

- 主题源：`themes/hanaagent.json`（明暗各 95 个 token）
- 只碰 `text/html` 响应，JS / CSS / 图片 / 接口原样透传
- **开关在 Hana 这边**：设置 → Hanako2DSH → `skinEnabled`（默认开）。改了刷新镜像页即生效，关掉则恢复 DSH 默认配色。侧栏窗格不再放这个开关——调色不是常用项，不占地方。

> 历史做法（1.8.1 及以前）：检出 `dsh-themes` 就只把卡片追加进它的 `custom[]`，不抢 `current`/`mixed`。这套机制在 DSH 0.2.1-rc.x 上失效了（`dsh-themes@0.2.1` 在那边注册不了 `/api/dsh-themes`），所以改成自己接管；那段代码仍在，`dsh-themes` 恢复后会继续兼容。

---

## 定时派活（1.9.0）

**入口在 Hana 这边**：侧栏窗格（Hanako2DSH 卡片）里的「定时」区，点右上角 **＋** 展开表单。频率按语义选，不用自己拼 cron：

| 频率 | 需要填的 | 实际存的 cron |
| --- | --- | --- |
| 每天 | 时间 | `分 时 * * *` |
| 每周 | 周几 + 时间 | `分 时 * * 周` |
| 每月 | 几号 + 时间 | `分 时 日 * *` |
| 每隔多久 | N + 分钟/小时 | `*/N * * * *` 或 `0 */N * * *` |
| 指定一次 | 具体日期时间 | 不走 cron，存 `at` 时间戳，跑完自动停用 |
| 高级 Cron | 5 段表达式 | 原样存 |

还可填名称（留空取任务前几个字）；已有任务可停用 / 删除。

命令行方式也保留：
```
hanako2dsh_schedule { "action": "add", "cron": "0 9 * * 1", "task": "巡一下工作区散落文件", "deliver": "new" }
hanako2dsh_schedule { "action": "list" }        ← 看全部任务与下次运行时间
hanako2dsh_schedule { "action": "remove", "id": "sch_xxx" }
```

**结果去向（deliver）**：

| 值 | 行为 |
| --- | --- |
| `none` | 不发送，只留在侧栏时间线 |
| `session` | 发到指定 Hana 会话（需同时给 `sessionPath`），用宿主 `session:send` |
| `new` | 先新建一个 Hana 会话再发进去，`session:create` + `session:send` |

**限制**：定时器跑在 Hana 进程里，**Hana 关着就不会触发**；重启后会按 cron 重新计算下次时间（错过的不会补跑）。

另：官方 `@deepseek-ai/dsh-schedule` 是**DSH 会话内的定时提醒**（`schedule_create/list/delete`，跟会话走），和这里的跨会话定时不是一件事；插件会自动探测它装没装，结果在 `status.compat.schedule`。

---

## 跨 DSH 版本的兼容层

DSH 还在快速变动，所以这里刻意**不按“最新版”写死**，而是探测实装的东西：

| 探测对象 | 做法 | 退路 |
| --- | --- | --- |
| DSH 本体版本 | 启动时跑一次 `dsh --version`，结果进 `status.compat.dshVersion` | 拿不到就是 null，不影响任何功能 |
| dsh-ops 条目 id | 读 `<profile>/node_modules/dsh-ops/cordis.patch.yml`，按它实际插入的 id 生成“禁用层” | 读不到则退回 0.3.x 的旧 id（shell/file/background/ptc） |
| 登录取 cookie | 先走 `GET /?token=`，失败再走 0.2.1 新增的 `/connect` | 两条都失败才报错 |
| 官方定时任务 | 探测 `@deepseek-ai/dsh-schedule` 是否装在该 profile | 未装则标 `installed:false` |

为什么这么做：dsh-ops 0.3.x 的条目叫 `dsh-ops-shell` / `file` / `background` / `ptc`，0.4.x 换成了 `mode-minimal` / `mode-standard` / `mode-ptc` / `mode-cordis` / `discovery` / `panel` / `tui`——写死任何一套，另一半机器上就失效。

---

## 从源码安装（开发者）

把本目录放进 `${HANA_HOME}/plugin-dev-sources/`，用 EventBus 的 `plugin.dev.install`（或 `POST /api/plugins/dev/install`）装进 dev 槽；改完 `plugin.dev.reload`。注意：**入口之外的子模块有 ESM 缓存**，改了 `lib/`、`routes/`、`tools/` 需要重启 Hana 才生效。

---

## 许可与致谢

Apache-2.0。

异步派活用到的宿主 `deferred` 通道调用方式，借鉴自 [KhalilYamber/dsh-envoy](https://github.com/KhalilYamber/dsh-envoy) 与 [Nyasers/dsh-hanako](https://github.com/Nyasers/dsh-hanako)（均为 MIT 许可），在此致谢。
