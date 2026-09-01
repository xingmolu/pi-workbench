# Pi Desktop UI 设计（调研稿）

日期：2026-08-31（MVP 覆盖于 2026-09-01 根据竞品调研更新）
前提：新仓库。引擎用 `@earendil-works/pi-coding-agent` SDK。界面学 DSH 对话密度 + Codex 右侧工作台。不 fork DSH，不复用 Cordis slot 实现。

---

## 1. 两边实际长什么样

### DSH 对话区（要抄的）

以下形态以官方截图和 `ui-conversation` / `ui-tool` 源码为基线；未能独立核验的旧截图细节单独标注：

- 左栏：工作区树，会话挂在文件夹下；「新会话」和设置入口。旧截图中的“插件市场固定在底栏”未能从当前源码独立核验，不纳入 Pi 信息架构。
- 中栏才是产品：空态 Hero（居中 slogan + 大输入框）→ 进会话后变成顶栏 + 节点流 + 底栏 composer。
- 对话是文档流，不是 messenger。Pi MVP 选择**没有头像、消息上没有时间戳**（相对时间只在侧栏会话行）；这是自身产品取舍，不再作为当前 DSH 的事实归因。
- Chat Node：
  - 用户：右对齐深灰 **胶囊气泡**；steering（中途插入）同款
  - 助手：**无气泡、贴画布** 的 Markdown，不要做成左右气泡对聊
  - 上下文注入：灰 metadata 行（「上下文注入 · @…」）
  - Think：当前源码能确认折叠 reasoning 和 turn-level process summary；旧截图中固定的「Thought for a while」与工具计数组合未能独立核验，不绑定该精确文案
  - 工具：流里的一行卡片（terminal / diff / read / search / web / generic），先 inline 展开；未来证据视图由显式 Inspect 动作打开
  - 回答脚：最多 6 个 deliverable 芯片；MVP 已实现**复制**。重试 / branch 要等 Pi 的会话语义明确后再做
- 工具卡片按 intent 分型：`terminal` / `read` / `diff` / `search` / `web` / generic
- DSH 点工具卡先 inline 展开，展开体里的 Inspect 才进入 trajectory / details。Pi 未来的证据视图也不能与 Workbench 混为一谈
- 顶栏 Tabs：`对话` | `轨迹`。轨迹是虚拟化时间线 + 右侧 payload 检查器，和对话抢同一块主列
- 列宽（照抄官方 grid）：sidebar 默认 **280**（264–420，收起 56 rail）；center 最小 **640**；官方 `details` 默认 **0 关闭**（开时 360，300–520）。我们的 Codex 工作台是新产品，不要复用官方 details 的 tool inspector。
- 内容轴：DSH 的 `--dsh-chat-content-width` 默认列宽 64%，夹在 680–920px，并提供拖拽。Pi MVP 目前只有响应式内容轴，用户拖拽宽度明确延期。
- Composer 是对话列里一张大圆角卡片，不是浮层。工具行：`+` · 权限芯片 · 模型 · **ContextMeter 圆环** · **蓝色圆 Send**。运行中空草稿 → Stop；有字 → Queue Send。DSH 的 Queue / Steer 交互只作为参考；Pi MVP 已实现 follow-up 队列和清空全部，单项 steer 延期。`@` 文件/会话原子芯片与图片粘贴附件也明确延期。
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
- **Conversation**：学 DSH 节点流。永远在。MVP 使用响应式内容轴；680–920px 用户可拖宽度是后续目标，本轮未实现。
- **Workbench**：学 Codex。默认只显示 **52px mode rail**；设置与 Browser 由用户显式触发展开，禁止 hover 打开。Browser 已是首个真实 mode；Files / Review / Terminal（+ Trace）仍是占位。按工作区记宽度和 tab 恢复后做。

这是基于 2026-09-01 竞品调研的阶段性覆盖：当前先保证对话、会话、账号、模型、审批、Context 和 Queue 的状态可信，不用空 Workbench 提前占据 360px。

空态：DSH Hero。没选 project 时，中间对话区的 Hero 显示唯一主动作「选择工作区」。

## 3. 对话区：抄密度，不抄 Cordis

节点 MVP：user / think / tool / assistant / error。工具卡片 intent：bash→terminal，read/ls→read，grep/find→search，write/edit→diff。tool 以稳定 `toolCallId` 关联审批和 `queued / awaiting-approval / running / success / error / blocked` 状态；运行中的 active session 派生 `idle / running / awaiting-approval / error`，侧栏和对话头读取同一 Host 状态。

Composer：`+` · 权限芯片（Open / Ask）· 账号 · 模型 · ContextMeter · 蓝色圆 Send（Send↔Stop↔Queue）。Ask / Open 是本次本地运行期审批策略，重启回 Ask，不等同于 OS sandbox 或持久 allow/deny 规则。运行中发送进入 Pi follow-up 队列；MVP 展示完整队列并支持清空全部，单项编辑、删除和 steer 后做。Context popover 只展示 Pi `getSessionStats()` 的 context tokens/window 与累计 input/output/cache，以及 Host 本次运行实测；缺失值显示未知，不伪造分类或美元费用。

## 4. 右侧 Workbench

Files：工作区树 + 预览 tab。Terminal：**用户 PTY**，Pi bash 仍走对话卡片。Review：Git，Last turn | Working tree；这三项尚未实现。Browser 已实现为 main process 持有的 `WebContentsView`：按 project 隔离持久 profile、多标签页、窄化 typed action、短寿命 snapshot ref，以及用户/agent 同页共享控制。Renderer 不持有 Node、Pi、CDP 或任意 eval；Agent Host 只能经 main capability bridge 请求固定操作。跟随产物克制：不因每次 write 切 Review。

Browser 网页内容明确标记为不可信。remote content 保持 sandbox、context isolation、关闭 Node integration；权限默认拒绝、下载阻止、popup 转受管 tab、远端仅 HTTPS（localhost 允许 HTTP）。用户操作优先并会取消 agent 在途动作，控制条提供 Stop。Open / Ask 继续决定普通 agent 交互是否进入批准卡；上传、下载、cookie/凭证导出和任意脚本执行不在工具面内。

## 5. 账号

凭证只在 `~/.pi/agent/auth.json`。一 provider 一槽；多号用别名（`anthropic-work`、`openai-codex-home`），兼容 `@hank-warren/pi-multi-login`。

**Codex（ChatGPT Plus/Pro）— 直登必须有，导入只是顺手**

- 主路：设置「登录 Codex」→ Pi `/login` → `openai-codex`（Codex for OSS）。OAuth 当前仍使用系统浏览器；loopback 失败走 device code。不会让 agent 借右栏 Browser 读取 provider 凭证。
- 多号：别名槽 `openai-codex-<slug>`，不覆盖主机 `~/.codex`。
- 延期：检测并导入 `~/.codex/auth.json` 只是便利能力，本轮未实现；没装 CLI 的人已经可以通过 Pi `/login` 直登。

**Claude**：Pi `/login anthropic` 是 extra usage，不是 Claude Code 套餐限额。不要默认导入 Claude Code token。这是本产品要求持续显示的政策文案。自定义 OpenAI/Anthropic 兼容端点及其 `models.json` + `auth.json` 管理 UI 明确延期，本轮未实现。

Composer 两级：账号 → 模型。浏览账号不创建会话；已有 transcript 的 session 钉死 provider/model，模型不可用时保持只读，不做静默 failover。Pi SDK `0.84.4` 的公开 `ModelRuntime.login()` 在返回前已同步该进程中的凭证、catalog 与 availability 投影；登录后重新读取公开投影，不直接操作私有 `authStorage.reload()`。升级 SDK 时重新核验这一约束。

## 6. 手机端与外网（后续目标，本轮未实现）

桌面 = runtime，手机 = 同一 session 的 PWA 对话面。MVP：会话列表、接着聊、Stop/Queue/Steer、Ask 批准、跑完推送。Files/Git/终端/浏览器不上手机。

可达性：1) LAN 扫码 2) 一键 Cloudflare Quick Tunnel（4G 主路，无账号，URL 每次变）3) 高级：Tailscale / 命名隧道 / 自建。Gateway 绑 loopback。不要端口转发 0.0.0.0。一次性配对 + 按设备 grant，桌面可撤。开外网时防休眠。文案：「手机能用这台电脑上的工具改文件、跑命令。只扫你自己的码。」

## 7. 进程与数据

Renderer (React) — 零 Node、零 Pi import。typed IPC。Main：窗口、最近项目偏好、BrowserManager 和 `utilityProcess` 生命周期；Agent Host：`utilityProcess` 中的 Pi runtime 与 browser capability client，生产 `agentDir = ~/.pi/agent`。对话是按 `cwd` 分桶的 Pi JSONL 投影，Electron 不保存 transcript 副本或 token。`electron-store` 只保存最近项目路径；Browser profile 由 Electron partition 按 project 隔离。这些本地数据不含 Pi token/transcript，但路径本身和网站登录态仍应按本地隐私数据对待。

流式同步先发送带 `sessionId + generation + revision` 的完整 snapshot，之后发送带 `baseRevision + revision` 的节点 upsert / removal / order patch 和轻量元数据。token 更新按短窗口合并，completed / settled 强制刷新；Renderer 对旧 patch 幂等忽略，对会话代际不匹配、乱序或 revision 缺口重新拉 snapshot。完整 snapshot 用于 bootstrap、项目/会话切换与恢复同步，不在每个 token 上重复传整份 transcript。

## 8. 明确不做什么

不 load DSH Web UI；不把 pi-web-ui 当主界面；不 fork dsh-desktop；不自造 OAuth；不把 Codex 做成只能导入 CLI；不把 Agent 端口转到公网；手机 MVP 不做工作台；不做多账号自动 failover。

## 9. 建议落地顺序

1. 壳：三栏 + Hero + 工作区会话树（MVP 已覆盖）
2. 对话节点流 + composer + metrics（MVP 已覆盖 snapshot + revision patch、状态、Context 与 Queue；`@` / 图片附件和可拖内容轴延期）
   - **2b.** 账号：Codex 直登 + composer 两级切换（MVP 已覆盖显式选择与 session pinning；`~/.codex/auth.json` 导入和自定义兼容端点 UI 延期）
   - **2c.** 手机：gateway + 配对 + LAN QR + Quick Tunnel
3. Browser + agent 共享控制（已覆盖首个真实 Workbench mode、隔离 profile、typed capability 与 E2E）
4. Files + Review
5. 用户 PTY
6. Trace 等
