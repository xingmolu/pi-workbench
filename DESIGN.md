# Pi Desktop UI 设计（调研稿）

日期：2026-08-31
前提：新仓库。引擎用 `@earendil-works/pi-coding-agent` SDK。界面学 DSH 对话密度 + Codex 右侧工作台。不 fork DSH，不复用 Cordis slot 实现。

---

## 1. 两边实际长什么样

### DSH 对话区（要抄的）

官方截图和 `ui-conversation` / `ui-tool` 源码对得上：

- 左栏：工作区树，会话挂在文件夹下；「新会话」；底栏设置 / 插件市场。
- 中栏才是产品：空态 Hero（居中 slogan + 大输入框）→ 进会话后变成顶栏 + 节点流 + 底栏 composer。
- 对话是文档流，不是 messenger：**没有头像，消息上没有时间戳**（相对时间只在侧栏会话行）。
- Chat Node：
  - 用户：右对齐深灰 **胶囊气泡**；steering（中途插入）同款
  - 助手：**无气泡、贴画布** 的 Markdown，不要做成左右气泡对聊
  - 上下文注入：灰 metadata 行（「上下文注入 · @…」）
  - Think：折叠行 + 截断灰摘要；Compact 是默认——一轮结束后过程收到「Thought for a while」/工具计数后面
  - 工具：流里的一行卡片（terminal / diff / read / search / web / generic），点路径 `openFile`，点检查才开 details
  - 回答脚：最多 6 个 deliverable 芯片；动作保留 **复制 / 重试**（赞踩可省略）
- 工具卡片按 intent 分型：`terminal` / `read` / `diff` / `search` / `web` / generic
- 点卡片会打开 **details**（`conversation.details.tool`），这是 DSH 仅有的「右侧」——检查器，不是工作台
- 顶栏 Tabs：`对话` | `轨迹`。轨迹是虚拟化时间线 + 右侧 payload 检查器，和对话抢同一块主列
- 列宽（照抄官方 grid）：sidebar 默认 **280**（264–420，收起 56 rail）；center 最小 **640**；官方 `details` 默认 **0 关闭**（开时 360，300–520）。我们的 Codex 工作台是新产品，不要复用官方 details 的 tool inspector。
- 内容轴：`--dsh-chat-content-width`，默认列宽 64%，夹在 680–920px，可拖
- Composer 是对话列里一张大圆角卡片，不是浮层。工具行：`+` · 权限芯片 · 模型 · **ContextMeter 圆环** · **蓝色圆 Send**。运行中空草稿 → Stop；有字 → Queue Send。忙时 Enter = Queue/Steer。`@` 插入原子芯片（文件/会话），附件 MVP 先做图片粘贴。
- Stats 贴在卡片 **下面**：`1轮 · 1步 | LLM 1.7s | 首 token 平均 0.9s · 121 tok/s | 缓存命中 0% | 输入 7.8K tok · 输出 102 tok`。没有的字段就丢掉，不要假造美元费用。
- 主题：画布 `#0A0A0A`–`#121212`，composer `#1E1E1E`，强调蓝 ~ `#4B70E2`，圆角 8–16，正文 14。Hero slogan 才用衬线。

**DSH 没有 Codex 那种持久右侧工作台。** 文件、终端、diff、浏览器都不占常驻右栏。

### Codex 右侧（要抄的）

参照的是 **ChatGPT 桌面 → Codex 模式**（2026-07-09 并进桌面端），不是 VS Code 扩展。VS Code 里的 Codex 只是聊天 webview，文件/终端/diff 仍是宿主 IDE。

真实形状：**chat-first，证据在右**。中栏永远是对话；右栏是 mode picker + 内部 tabs，一次只显示一种工作台。不是 VS Code 活动栏，也不是 Claude Code 那种自由拼 pane。

- 右栏 mode：Files / Review / Browser / Terminal / Side chat / Sources / Summary
- 栏内可再开 tab：Review 常驻；`Cmd+P` 打开的文件变成 Review 旁边的 file tab；Browser 有自己的浏览器 tab
- 文件树可以叠在打开文件的更右侧，不是用户自己拼的分屏
- Terminal 有两个家：右栏 mode，以及独立底栏抽屉（`Cmd+J`）。**用户 PTY 和 agent 沙箱命令是分开的**——集成终端给用户敲，agent 可以读它，但 agent 自己的 bash 不往这只 PTY 里倒
- Review 是 **Git 工作台**：Unstaged / Staged / Commit / Branch / **Last turn**，不是「本 session 的 edit 列表」
- Browser：内嵌 Chromium，独立 profile；Annotating 可对页面元素留评论当指令
- 跟随产物很克制：跑完打开 deliverable 文件；**不会每次 edit 都强制切到 Review**
- 快捷键：`Cmd+B` 左栏，`Cmd+Opt+B` 侧栏/Review，`Cmd+Shift+B` 浏览器，`Ctrl+Shift+G` Review，`Ctrl+\`` 终端
- 反面教材：右缘 36px hover 弹出（#21140）、宽度全局共享（community #1380238）、窄窗口多 pane 互挤。我们：显式开关、宽度按工作区记、无 hover 打开

### 现有 Pi 桌面

NativePi / PiDeck / DLYZZT 都是「自绘 UI + Pi SDK/RPC」，没有一家把 DSH Web UI 嵌进来。DLYZZT 的 Main + Agent Host `utilityProcess` + 自带浏览器 WebContentsView，最接近我们要的进程模型。

---

## 2. 产品结构：三栏，不是两栏

- **Sidebar（Project + Session，一等公民）**：学 DSH 左栏。Project = 文件夹 = Pi cwd。Session 挂在 project 下（标题 + 相对时间，运行蓝点，待确认琥珀点）。`Cmd+B` 收成 56px rail。文件树不在左栏。
- **Conversation**：学 DSH 节点流。永远在。宽度轴 680–920 可拖。
- **Workbench**：学 Codex。默认开；可折叠成只剩 picker。宽度按 **工作区** 记住。Modes: Files | Review | Terminal | Browser（+ Trace 后做）。一次一个 mode。禁止 hover 打开。

空态：DSH Hero。没选 project 时右侧显示「选一个工作区」。

## 3. 对话区：抄密度，不抄 Cordis

节点 MVP：user / context / think / tool / assistant / error。工具卡片 intent：bash→terminal，read/ls→read，grep/find→search，write/edit→diff。

Composer：`+` · 权限芯片（Open / Ask）· 模型 · ContextMeter · 蓝色圆 Send（Send↔Stop↔Queue）。忙时 Enter = Queue/Steer。Stats 只用真实 Pi usage，不造美元费用。

## 4. 右侧 Workbench

Files：工作区树 + 预览 tab。Terminal：**用户 PTY**，Pi bash 仍走对话卡片。Review：Git，Last turn | Working tree。Browser：WebContentsView，独立 profile。跟随产物克制：不因每次 write 切 Review。

## 5. 账号

凭证只在 `~/.pi/agent/auth.json`。一 provider 一槽；多号用别名（`anthropic-work`、`openai-codex-home`），兼容 `@hank-warren/pi-multi-login`。

**Codex（ChatGPT Plus/Pro）— 直登必须有，导入只是顺手**
- 主路：设置「登录 Codex」→ Pi `/login` → `openai-codex`（Codex for OSS）。系统浏览器或右栏 Browser；loopback 失败走 device code。
- 多号：别名槽 `openai-codex-<slug>`，不覆盖主机 `~/.codex`。
- 顺手：检测到 `~/.codex/auth.json` 可导入。没装 CLI 的人必须能直登。

**Claude**：Pi `/login anthropic` 是 extra usage，不是 Claude Code 套餐限额。不要默认导入 Claude Code token。自定义 OpenAI/Anthropic 兼容端点写入 `models.json` + `auth.json`。

Composer 两级：账号 → 模型。新会话跟 active 账号；已打开的 session 钉死。不做静默 failover。登录后 `authStorage.reload()`。

## 6. 手机端与外网

桌面 = runtime，手机 = 同一 session 的 PWA 对话面。MVP：会话列表、接着聊、Stop/Queue/Steer、Ask 批准、跑完推送。Files/Git/终端/浏览器不上手机。

可达性：1) LAN 扫码 2) 一键 Cloudflare Quick Tunnel（4G 主路，无账号，URL 每次变）3) 高级：Tailscale / 命名隧道 / 自建。Gateway 绑 loopback。不要端口转发 0.0.0.0。一次性配对 + 按设备 grant，桌面可撤。开外网时防休眠。文案：「手机能用这台电脑上的工具改文件、跑命令。只扫你自己的码。」

## 7. 进程与数据

Renderer (React) — 零 Node、零 Pi import。typed IPC。Main：窗口/托盘/WebContentsView/pty。Agent Host：utilityProcess，`createAgentSession()`，`agentDir = ~/.pi/agent`。对话是 Pi JSONL 投影。

## 8. 明确不做什么

不 load DSH Web UI；不把 pi-web-ui 当主界面；不 fork dsh-desktop；不自造 OAuth；不把 Codex 做成只能导入 CLI；不把 Agent 端口转到公网；手机 MVP 不做工作台；不做多账号自动 failover。

## 9. 建议落地顺序

1. 壳：三栏 + Hero + 工作区会话树
2. 对话节点流 + composer + metrics
2b. 账号：Codex 直登 + composer 两级切换
2c. 手机：gateway + 配对 + LAN QR + Quick Tunnel
3. Files + Review
4. 用户 PTY
5. Browser
6. Trace 等
