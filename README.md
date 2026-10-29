# Hanako2DSH

把本机官方的 DeepSeek Harness（DSH）接进 Hana：黑板上一整页活的 DSH，一句话把活派给它，结果自动回到对话；附带一套 Hanako 皮肤。

> 仓库两条线：
> - `main`：v1 插件（永久兼容层），已经装着的机器可以继续用。
> - `v2`（默认分支）：v2 App，住进 `<HANA_HOME>/apps/hanako2dsh/`，页签进 Hana 的页面切换条。
>
> 两代功能不完全一致，差异写在下面「v2 与 v1 的差别」里。

## 结构：为什么不是一个插件塞一个进程

v1 的桥直接跑在 Hana 的插件进程里，自己起代理、自己 spawn DSH、自己读 `~/.dsh`。v2 的 AppHost 不允许这些：

| v1 依赖 | v2 AppHost 的实际情况 |
| --- | --- |
| `net.createServer` 起本地代理 | 权限模型关了 net，`ERR_ACCESS_DENIED` |
| 读 `~/.dsh` 的 profile / 账号文件 | 安装目录之外不可读 |
| `deferred:*` 异步回传 | 是 v1 专有总线动词，v2 里没有 |

所以桥整体搬进一个**受管运行时**（`ctx.runtime.start`，`profile: "local-machine"`，`network: "external"`），它跑在独立的 Node 进程里，本机文件和网络都在它手里。App 进程只剩薄薄一层：

```
App (index.js)                      受管运行时 (runtime/server.mjs)
├─ 五个工具  ──ctx.runtime.fetch──▶  DshBridge
│                                     ├─ 起代理 127.0.0.1:41888
└─ 页面 ui/dsh.html ─iframe────────▶  ├─ spawn DSH web
                                      ├─ 派活 headless
                                      └─ 定时派活 + outbox
```

代理端口写死 **41888**。页面里的 iframe 直接指向它，端口一变页面就白屏，所以桥发现端口被占用会直接启动失败，不会偷偷换一个。

## 装

1. 把整个 `hanako2dsh/` 目录（或打包出的 .zip）装进 HanaAgent 设置 → 扩展 → 已安装 → App 类目的安装入口
2. 首次装载会弹确认卡，逐条列出它要的能力：
   - **在本机跑一个受管程序**（`app/runtime.local-machine`）——桥需要本机文件与网络，等于「以你的身份动本机」
   - **网络**（`app/runtime.network`）——自己监听 41888、连本地 DSH
   - **后台任务与会话投递**（`app/tasks.manage` / `app/session.start-turn` / `app/sessions.manage`）——异步派活与定时结果回到对话
   - **把工具暴露给模型**（`app/tools.expose-to-model`）
3. 装完在 设置 → 扩展 → Hanako2DSH 里确认 DSH 安装目录（留空会自己探测 `D:\Program Files\deepseek-harness`）

要求宿主版本：1.3.6-beta 及以上。

## 用

页面：页面切换条里会出现「DSH」这一页，进去就是活的 DSH 界面，跟浏览器里开一样，皮肤由代理注入。

派活（对话里）：

| 想干什么 | 说 |
| --- | --- |
| 派个活并等结果 | 「让 DSH 把这个仓库的测试跑一遍，修到绿」 |
| 异步派活，结果自己回来 | 默认就是异步：工具先回「已派单」，跑完结果自动回到这次对话 |
| 看状态 | 「DSH 现在什么状态」 |
| 改工作目录 | 「这个会话派活改用 D:\foo」 |
| 定时 | 「每天早上 9 点让 DSH 汇总昨天的提交，发到这个会话」 |

## v2 与 v1 的差别

- **页面**：v1 是插件页 + 自己的工具栏；v2 是 Hana 页面切换条里的一整页，内容就是 DSH 本身。没有侧栏时间线与急停按钮——需要停下时对 Agent 说「别跑了」或让它调 `control`。
- **定时投递**：受管运行时没有宿主总线，结果先写进 outbox 文件，App 进程每 20 秒来拉一次，用 `sessions.send` 发出去，发完再 ack。所以到点后最多有 20 秒延迟。
- **设置改完要重启桥**：设置页改的是 App 的设置表，桥读的是自己的 `config.json`，App 每次起运行时会同步一次。改完设置后跑一次 `control restart` 最稳。

## 工具

| 工具 | 作用 |
| --- | --- |
| `run` | 派一个 headless 任务，同步等或异步回传 |
| `status` | 端口、就绪、cookie、最近错误、当前 cwd |
| `diagnose` | 安装目录、cli.js、凭据文件、版本兼容探测 |
| `control` | start / stop / restart / pinCwd / unpinCwd，顺带改安装目录与自动拉起 |
| `schedule` | 定时任务的增删查启停 |

## 目录

```
manifest.json          v2 清单：能力、页面卡、设置 schema
index.js               App 入口：注册工具、按 autoStart 拉起、扫 outbox
runtime/server.mjs     受管运行时入口：起桥 + 打印就绪标记
lib/bridge.js          DSH 桥核心（代理、spawn、派活、皮肤注入）+ /__api 控制面
lib/client.js          App 侧的 HTTP 客户端与运行时生命周期
lib/tools.js           五个工具
lib/outbox.js          定时结果收件箱
lib/schedule.js        定时派活器
lib/compat.js          dsh-ops / dsh-schedule 版本探测
lib/cron.js            5 段 cron 解析
lib/skin.js            把主题卡编译成注入用的 CSS
ui/dsh.html            页面：iframe + 心跳 + 状态页
themes/hanaagent.json  皮肤定义
sdk/                   随包携带的 @hana/app-sdk 运行时闭包
```

## 已知边界

- 只支持 Windows（DSH 桌面版只有 Windows 形态）。
- 代理端口固定 41888，被别的程序占了就起不来；`diagnose` 里能看到原因。
- 页面 iframe 依赖 DSH 那边允许被嵌；DSH 升级若改了 `frame-ancestors`，页面会白屏但派活仍然可用。
- `local-machine` 档位没有文件系统隔离，这是它能在本机干活的前提，也是它需要你明确点一次同意的原因。

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
