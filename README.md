# Pi Desktop

Pi Desktop 是一个本地 Electron + React 客户端，直接嵌入
`@earendil-works/pi-coding-agent`。它不加载 DSH Web UI，也不复制 Pi 的会话或凭证。

当前 MVP 覆盖 [DESIGN.md](./DESIGN.md) §9 的步骤 1、2、2b、3 和 3b：

- 文档流对话节点：user、assistant Markdown、think、tool；
- 代码块复制/换行，表格保护复制、系统 CSV 保存和冻结内容的分页只读预览；
- composer：Open / Ask、账号 → 模型、ContextMeter、Send / Stop / Queue；
- 文本上下文：加号选择文件或 Files「添加到对话」，快照附件、失败保留和 canonical 历史展开；
- 会话标题、运行/待确认/错误状态、同会话模型切换，以及完整 follow-up 队列；
- 真实 Pi usage、context 和本次运行期时序指标，不估算费用；
- Codex（ChatGPT Plus / Pro）浏览器登录与 device code；
- Pi 多账号 provider 别名 `openai-codex-<slug>`；
- 自定义 OpenAI Chat Completions / Responses、Anthropic Messages 端点设置；
- 按 canonical session cwd 隔离的 Pi JSONL 会话列表、新建与恢复（保留 CLI 目录编码）；
- 已保存会话重命名、当前工作区标题搜索和当前对话的问题导航；
- 已保存会话当前历史分叉为新会话、来源导航与原会话草稿保留；
- Main 发布的 typed Workbench registry、默认 52px mode rail，以及按需展开的账号、模型与
  Desktop 插件设置；
- Files 已支持当前项目的只读目录浏览、文件名搜索、隐藏文件开关、刷新、UTF-8 文本预览与复制；
  Review 已支持只读 Git 未暂存、已暂存和明确选择基准的分支差异；Terminal 提供独立的真实用户 PTY、多标签页和显式创建/结束。Browser 是 Main 持有的原生
  `WebContentsView`，支持多标签页、按 project 隔离的持久 profile 和用户/agent 共享控制；
- 本地 `sandboxed-web` Workbench 插件：严格 manifest、独立 `WebContentsView`、窄化
  `window.piPlugin` bridge、按 project 状态和崩溃隔离；
- Pi `browser` 工具：snapshot/ref、click/fill/select、导航、wait、screenshot 与 Stop。

Files 不支持编辑、重命名、删除或自动附加到对话；仅预览不超过 1 MiB 的 UTF-8 文本，二进制/非 UTF-8 内容会在检测后拒绝预览，符号链接和 Git 内部路径禁止访问。搜索仅匹配文件名，并跳过依赖与构建目录；达到扫描上限会提示结果不完整。这是应用级只读路径边界，不是针对恶意本机进程的 OS sandbox。

表格默认文本保护模式会在每格前添加单引号（包括表头），这是明确的数据变更，不保证所有表格软件的公式安全；原始值模式需显式选择。CSV 保存由系统对话框指定路径，取消不报成功；复制和保存各自反馈结果。最多 10,000 单元格、200 列、1 MiB，超额拒绝而不截断；预览每次加载 200 行。超过 200 KiB 的单块 Markdown 显示完整纯文本，高亮和可执行 artifact 未实现。实现、截图和验证边界见 [Markdown 结果操作验收](./docs/MARKDOWN_ACTIONS_ACCEPTANCE_2026-09-11.md)。

文本文件需明确点击加号或 Files「添加到对话」，最多 4 个，单文件 1 MiB、合计 2 MiB；只支持普通 UTF-8 文本，含无扩展名文本和配置文件。发送的是选取时的内容快照，不是只有文件名；原文件之后修改或删除不改变该快照。未发送附件在切换会话后清除，30 分钟过期在下次操作时校验。附件暂只支持空闲时发送，忙碌时保留文件且仍可 Stop；图片、拖放、粘贴和 PDF/Office 解析尚未实现。

附件发送失败时保留草稿；结果未知时只能查询原发送，不自动重发。Pi 预检接受不等于落盘或回答成功。已发送文本保存在 Pi 自己的 canonical 消息中，重开会话可展开查看，不另存 transcript。SDK 内部预检接缝固定到已验证的 `0.84.4`，升级需重新运行兼容回归。
测试范围、截图和独立本地包见 [文本上下文验收](./docs/TEXT_CONTEXT_ACCEPTANCE_2026-09-11.md)。
会话目录编码可能碰撞（例如 `a-b` 与 `a/b`）。Host 按 SDK 公共会话信息的绝对 cwd 过滤列表及自动恢复，显式打开还校验路径归属；创建项目服务前再次检查实际 manager cwd。详见 [会话 cwd 隔离验收](./docs/SESSION_CWD_ISOLATION_ACCEPTANCE_2026-09-11.md)。



当前源码提供最近问题的「编辑问题」入口（已通过独立规格与质量审查）：独立编辑框只改文字，保留原文本快照和图片，不覆盖普通输入框草稿。取消不发送；明确发送后在同一会话从原问题之前继续，旧记录仍保留，但暂不提供旧分支切换器。文件和终端操作不会撤销，工具可能再次执行。发送结果未知时只查询，不直接重发；引擎断开后使用编辑区重连入口核对历史。附件增删、任意历史编辑和助手重试不在当前实现内。验收及包版本边界见 [编辑验收记录](./docs/SESSION_EDIT_ACCEPTANCE_2026-09-11.md)。
Git 写入、Trace、手机网关和 worktree / 并行 agent 仍是后续边界。插件
marketplace、签名、自动更新、远端 UI 入口、第三方 native/module、通用 agent command
绑定和 MCP Apps 也明确延期。`@` 文件/会话引用、
图片粘贴附件、用户可拖内容轴及 `~/.codex/auth.json` 便利导入也明确延期。

设置中的「自定义端点」无需先选项目，直接管理 Pi CLI 共用的 `~/.pi/agent/models.json` 与 `auth.json`，影响所有工作区。明确选择协议、填写显示名称、服务地址、API Key 和每行一个模型 ID；新端点不会自动切换当前账号。地址只允许 HTTPS 或显式本机 HTTP，后者会提示明文传输风险。模型移除须确认；高级配置只读，损坏文件不能用空配置覆盖。密码不进入 Renderer 全局 store，表单值在提交/关闭时清空；编辑留空保留原凭证，不回显旧 key。

端点保存分别显示配置、凭据和运行时结果，不假装两个文件是一个事务。部分保存或结果不确定时先核对列表与登录状态，不自动重试；“刷新列表”只读配置，不修复运行时。当前模型被移除、配置发生漂移或运行时同步失败时，Host 和 composer 都阻止发送；历史保留，要求明确恢复或重选，不自动 failover。保存与登录启动/别名重载串行，进行中的 OAuth 不会被表单取消。隔离验证与边界见 [端点验收记录](./docs/CUSTOM_ENDPOINT_ACCEPTANCE_2026-09-11.md)。

用户终端无需 Pi 登录：点击工作台「终端」后显式新建，以所选项目为初始 cwd 启动本机用户 shell。它具有当前 OS 用户权限，不是项目沙箱，不受 Agent Ask/Open 审批；输入、输出与剪贴板内容不会进入模型或 Pi transcript。隐藏面板、切换标签或项目保留同一 xterm/parser/PTY；隐藏终端继续解析输出并在 write 完成后 ACK。每项目最多 4 个、全局最多 8 个运行终端，Renderer 最多保留 8 个屏幕（含已退出屏幕），达到上限须先显式关闭一个；每屏幕 scrollback 2,000 行。

若结束期间切换项目，已退出终端的屏幕/记录仍计入上述 8 个保留额度，返回所属项目后继续完成关闭；没有额外无界的待删除缓存。已退出屏幕仍可选择、复制和滚动。Renderer reload 后历史屏幕不可恢复，管理记录不冒充保留屏幕。

粘贴统一限制为 8 KiB UTF-8，含换行或控制字符时先预览确认；取消不发送，确认交给 xterm 的 bracketed paste。关闭终端会请求结束 shell/常规任务，不能保证回收 detached daemon；替代终端必须等待实际退出确认。OSC 标题只作为有界非可信文字；OSC52 被禁用，OSC8 不打开外部链接。Renderer reload 后仅显示管理态「终端进程仍在，屏幕状态未恢复」，需明确结束并新建，不自动重放命令或假恢复 TUI。无损 reload/TUI 恢复、原生锁屏后键盘/剪贴板验收、签名安装包验证仍未完成。

技术选型与取舍见 [docs/TECH_STACK_RESEARCH.md](./docs/TECH_STACK_RESEARCH.md)，本轮竞品调研与落地映射见
[docs/COMPETITIVE_RESEARCH.md](./docs/COMPETITIVE_RESEARCH.md)，Workbench / Agent Browser
专项调研与实施结果见 [docs/WORKBENCH_AGENT_RESEARCH.md](./docs/WORKBENCH_AGENT_RESEARCH.md)。
已落地的插件边界、manifest 和 panel API 见
[docs/WORKBENCH_PLUGIN_ARCHITECTURE.md](./docs/WORKBENCH_PLUGIN_ARCHITECTURE.md)。

## 本地运行

macOS Apple Silicon 上安装依赖并启动开发环境：

```bash
npm ci
npm run rebuild:pty
npm run smoke:pty
npm run dev
```

PTY 的 native 准备不可省略：干净安装的 node-pty 1.1.0 预构建 helper 不可执行，须使用官方 electron-rebuild 定向重建。当前脚本固定 Electron 44.1.0 / arm64，需要 Xcode Command Line Tools（含 macOS SDK、clang）与 Python；已验证 Xcode 26.6 / SDK 26.5 / Python 3.9.6。其他平台/架构尚未验收，详见 [包资源验收](./docs/USER_TERMINAL_PACKAGE_ACCEPTANCE_2026-09-11.md)。

开发时 Renderer 默认运行在 `http://127.0.0.1:43123`。

常用验证命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run smoke:electron-store
```

- `npm run typecheck`：检查 Main / Agent Host 与 Renderer 的 TypeScript。
- `npm test`：运行 Vitest 单元与进程边界测试，不含 Electron E2E。
- `npm run build`：生成 `out/` 下的 Electron 构建产物。
- `npm run test:e2e`：先 build，再由 Playwright 启动构建后的真实 Electron
  Main、sandboxed Renderer 和 `utilityProcess` Agent Host。测试使用隔离的临时
  userData、agentDir 与 project，不读取或写入生产 Pi 数据。
- `npm run smoke:electron-store`：先 build，再在 Electron 主进程环境验证构建后的
  `electron-store` 可以读写。

E2E 会把空态、设置、项目门禁、Browser chrome/网页执行、真实 sandboxed plugin 面板和
三次崩溃诊断截图写入 `artifacts/e2e/`；该目录已加入 `.gitignore`，只作为本地验证产物。

如需生成本地安装目录，可另外运行：

```bash
npx electron-builder --dir
```

Apple Silicon 上进行本机打包验收（不自动选用钥匙串中的分发证书）：

```bash
npm run rebuild:pty
npm run smoke:pty
npm run build
npx electron-builder --mac --arm64 --dir -c.mac.identity=- -c.mac.hardenedRuntime=false -c.directories.output=dist/local-debug
npm run smoke:pty -- "--bundle-resources=$PWD/dist/local-debug/mac-arm64/Pi Desktop.app/Contents/Resources"
```

这是 ad-hoc 签名的本地调试包，不修改 macOS 系统安全设置，不代表正式分发配置。
最后一条命令由开发 Electron 在隔离夹具中加载包内 native/helper，仅验证资源兼容，不启动产品包正常入口。
正式发布需要有效签名身份、兼容的 hardened runtime entitlements 和公证。
打包仅包含 `out/`、`resources/`、`package.json` 与生产依赖，排除旧 `dist/`、测试截图和报告。

## 使用

1. 左侧“打开文件夹”选择项目；该路径就是 Pi 的 `cwd`。
2. 打开“设置 → 账号与模型”，点击“浏览器登录”。应用调用 Pi
   `ModelRuntime.login('openai-codex', 'oauth', …)`，使用与 Pi
   `/login openai-codex` 相同的登录能力，不自行实现或复制 OAuth 凭证。
3. 若本机 loopback 端口不可用，Host 自动选择 device code；也可以直接点击“设备码”。
4. 登录后在 composer 先选账号、再选模型。浏览账号不会创建会话；已有 transcript
   时选择另一模型会在同一 Pi session 追加 canonical `model_change`，保留全部上下文。
   新会话仍从当前 active 账号与模型开始，模型不可用时不会静默切换。
5. Ask 是本次应用运行期的审批策略，会在 bash、powershell、write、edit 前显示确认；
   Open 允许 Pi 在本次运行中直接调用工具。重启后恢复为 Ask；它们不是 OS sandbox
   或持久 allow/deny 规则。
6. agent 运行中发送的新输入进入 Pi follow-up 队列；界面显示完整待发送文本，并支持清空全部队列。单项编辑、删除和 steer 尚未实现。
7. 点击右栏 Browser 后可以手动浏览；Pi agent 使用同一个可见 tab。Ask 模式下交互动作会进入现有审批卡，Open 模式下直接执行；浏览器工具条会显示控制方，用户可随时 Stop 或直接接管。
8. 未发送草稿在本次窗口运行期间按项目和会话隔离，切换模型不清空。发送确认前保留原文，失败可直接重试；确认期间的新编辑不会被旧请求清空。草稿仅存内存，不另建 transcript，关闭应用后不保留。
9. 阅读历史时流式输出不会强制跳底，可点击“回到底部”恢复跟随。引擎意外退出后锁住发送，保留当前画布和草稿；点击“重新连接引擎”恢复项目和已保存的当前会话，不自动重发任务或恢复执行队列。引擎重启后权限回到 Ask。
10. 主动停止显示“已停止”，保留部分输出；重开会话也使用 Pi 的 canonical `stopReason` 恢复该状态，不当作失败。中断请求没有最终可信 usage 时不显示 0 tok/s，累计仅含已报告用量。
11. 待确认操作在 composer 上方有常驻跳转入口；卡片先显示动作与域名摘要，详细参数可展开，确认只允许本次操作。
12. 模型来自 Pi 的可用目录，但目录不能保证 ChatGPT 账号支持每个模型。收到 Codex 明确的“不支持此模型”响应后，仅在当前 Host 运行期禁用该账号的对应模型；网络、限流和取消不触发禁用。切换其他模型保留会话；重新登录该账号或重启 Host 后可重试，不自动 failover。
13. 顶栏“重命名会话”只用于引擎就绪、未运行的已保存当前会话；名称去掉首尾空白后最多 80 个 Unicode 字符，不允许空名称、控制字符或换行。名称通过 Pi 的 `setSessionName()` 追加到原 JSONL，原消息和文件路径保留。保存失败显示局部错误；真实写盘失败会断开引擎，保留画布，显式重连恢复已保存的名称后才可重试。
14. 侧栏“搜索会话标题”仅筛选当前工作区已加载的标题，支持中文和不区分大小写的匹配；清除后回到完整列表，切工作区清空搜索。顶栏“问题导航”按当前对话的用户问题顺序定位并聚焦原消息，阅读历史时保持滚动位置；回到底部或手动滚到底部可恢复跟随。
15. 对话展示 Pi JSONL 当前分支的完整历史：同一时间的不同问题分别保留，压缩前的问题仍可通过问题导航定位，其他分支不混入当前画布。模型记录在原位置显示“模型 / 模型切换”及 provider、model ID；压缩只显示低干扰的边界提示，不把内部摘要当作助手回答。历史身份来自 canonical entry ID，不依赖消息时间戳。
16. 流式期间展开的思考和工具详情在正式存入历史及本次会话刷新后保持展开。显示身份仅在运行期保留，不写入 transcript；重新打开会话可恢复为默认折叠。

模型切换写入失败且运行时已改变时，会断开引擎并保留最后可读画布和草稿；显式重连从实际文件恢复，不自动重试或假设已回滚。模型选择的前置验证错误仍可恢复。模型事件观察覆盖不同模型的 extension 切换；extension 重复选择同一模型未触发公开事件时，追加记录在下一次正常历史刷新时出现。显示投影失败也会中止该 Host，避免继续发布不一致状态。上述保护不是所有 Pi 写盘路径的事务屏障，成功 append 也不等于 fsync 持久化。

`tests/e2e/session-history.spec.ts` 使用独立 HOME、agentDir、项目和 userData，通过真实 Electron → Host → Pi SDK 验证 canonical 历史、模型切换、公开 faux provider 的离线流式与重复 tool ID 审批。写入失败仅将一个测试 JSONL 临时替换为目录（EISDIR），在显式重连前恢复；它验证第一次模型 append 失败，不宣称覆盖后续 thinking append 部分写入。截图为 `artifacts/e2e/session-history.png`、`session-history-960.png`。这不是付费模型、真实账号或原生输入法/系统剪贴板验收。

会话发现功能使用临时 agentDir、项目和 userData 的真实 Electron E2E 验证；写盘失败仅修改测试 fixture 权限，不使用生产账号。流式更新与延迟/拒绝响应的注入测试均单独标注。截图位于 `artifacts/e2e/session-discoverability.png` 与 `session-discoverability-960.png`。此阶段尚未重新完成原生打包验收，Mac 锁屏限制仍单独记录。

聊天可靠性回归见 `tests/e2e/conversation-reliability.spec.ts`：在真实 Electron 中使用
隔离测试快照、IPC 失败/延迟注入、真实进程退出和 Pi JSONL 恢复，不调用付费模型或真实 OAuth。

## Git Review

右栏“审查”提供只读 Git 差异：未暂存为 index→working tree，已暂存为 HEAD→index（支持尚无提交的仓库），分支为用户明确选择的本地或远端引用与 HEAD 的 merge-base→HEAD，只含已提交内容；不联网获取引用。分支清单捕获 commit OID，工作区/暂存区内容则在每次请求时读取，并非原子快照。

文件逐项加载，默认统一视图，可切为分栏。未跟踪文件单列，复用 Files 的有界只读预览；冒号/反斜杠等 Files 不支持的路径仍列出，但不可预览。二进制、冲突、子模块、类型变化和空差异有独立说明。解析失败、非 UTF-8 字节转义内容，或超过 2,000 行 / 200,000 字符的 patch 显示完整“原始差异”，不静默截断；Main 输出预算超限则明确报错。

维护提示：大量 diff 行组件的渲染开销较高，阈值不能只按 Git 输出字节预算决定；调整回退策略时同时做交互性能回归。参见 [react-diff-view 官方性能说明](https://github.com/otakustay/react-diff-view#full-features)。

切模式、文件、项目或关闭面板会丢弃迟到的 Renderer 响应；Main 仅在项目切换/引擎退出时撤销能力并终止相应 Git 进程。引擎断开后清空差异，重连刷新。没有暂存、丢弃、提交、checkout、fetch 或 push 控件；首版不做 rename detection、Last turn、冲突编辑和语法高亮。检测到有效 clean/process 过滤器配置时，扫描会明确拒绝；该边界不是抵御恶意本机进程或动态配置竞态的 OS sandbox。

`tests/e2e/git-review.spec.ts` 在独立 HOME、agentDir、userData 和临时仓库中运行真实 Git/Electron；迟到响应和异常回退另用明确标注的模拟 IPC。截图为 `artifacts/e2e/git-review.png` 与 `git-review-960.png`；原生安装包验收单独记录。

## Workbench 本地插件

独立的用户级 Desktop 插件采用手工安装布局；每个直接子目录是一项插件：

```text
~/.pi/agent/desktop-plugins/<id>/
├── pi-desktop.json
├── index.html
└── panel.js
```

复制或修改文件后，到“设置 → 工作台插件”点击“重新加载”。当前没有安装、卸载或更新
UI。设置中的 Desktop 开关只隐藏 contribution 并销毁对应面板，不会卸载、停止或禁用
Pi Agent Host 已加载的 Skills/Extensions。

Pi package 也可以在 package root 并置 `pi-desktop.json`，但 Main 不会遍历任意 Pi 或
project 目录。只有 Agent Host 的公开 resource loader 在当前 generation 中实际加载的
package-scoped Skill/Extension root，才会作为可信的规范化 root 发布给 Workbench Host。
Main 在发现 manifest 前按真实规范路径合并用户插件 root 与 Pi package root；同一目录的符号链接
别名只会注册一次，并保留“含已加载 Extension”的警告。package 的 `baseDir` 与 resource loader
原始 `source` 只在 Host 信任边界内使用，Renderer 仅收到固定的“本机插件 / Pi 用户包 /
Pi 项目包”来源类别，不会收到路径、URL 或凭证片段。
完整 manifest、bridge、安全与信任说明见
[Workbench 插件架构与作者指南](./docs/WORKBENCH_PLUGIN_ARCHITECTURE.md)。

## 数据与隐私边界

生产运行的 Pi `agentDir` 固定为 `~/.pi/agent`：

- 凭证与自定义模型：`~/.pi/agent/auth.json`、`~/.pi/agent/models.json`
- 会话：`~/.pi/agent/sessions/` 下按 `cwd` 分桶的 JSONL
- 多账号配置：`~/.pi/agent/pi-multi-login.json`

应用不会把 token 放进 Electron `safeStorage`，也不会保存第二份 transcript。Main 使用
`electron-store` 保存最近一次成功打开且已规范化的项目路径、Desktop 插件启用状态，
以及每项不超过 32 KiB 的插件面板 JSON 状态。项目路径在启动时会重新校验，失效后清除；
面板状态按 `pluginId/viewId/project` 分桶，不应写入 token、transcript、cookie 或 tool
secret。这些都是本地偏好数据，但路径和插件自存内容仍应按本地隐私数据对待。测试专用
agentDir 覆盖只允许在未打包的显式 E2E 模式中使用，生产构建会拒绝该模式并忽略其他路径
覆盖值。

Browser 使用 project 路径的不可逆 hash 生成独立 Electron partition；cookie、localStorage
等网站会话数据留在该 profile，不写入 Pi 的 `auth.json`，也不会通过 snapshot 返回给 agent。

## 架构

| 进程/表面                   | 职责                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Main                        | 窗口、项目偏好、WorkbenchHost、BrowserManager、安全策略、typed IPC、`utilityProcess` 生命周期          |
| Agent Host                  | Pi runtime、登录、流式投影、权限 hook、browser capability client，并发布当前实际加载的 Pi package root |
| Terminal Host               | 独立 Node utilityProcess；仅此进程加载 node-pty，管理用户 shell、输出流控和实际退出；不经过 Pi transcript |
| 主 Preload                  | 只暴露窄的 `window.pi` 请求与事件 API                                                                  |
| 主 Renderer                 | React 文档流、registry rail、first-party chrome、Radix/Zustand；零 Node、零 Electron、零 Pi import     |
| sandboxed plugin preload/UI | 只暴露冻结的四方法 `window.piPlugin`；UI 在独立 Main-owned `WebContentsView` 中加载包内静态资源        |

Host 在初始化、项目/会话切换和重新同步时发送完整 snapshot；随后发送带
`sessionId + generation + baseRevision + revision` 的节点 patch。Renderer 只按连续 revision
合并，遇到会话代际不匹配或 revision 缺口时重新请求 snapshot。

关键入口：

- `src/agent-host/index.ts`：Pi runtime、登录、会话、权限与节点投影
- `src/shared/contracts.ts`：跨进程 DTO 与 snapshot / patch 协议
- `src/shared/workbench-contracts.ts`：renderer-safe contribution、plugin、panel context/state DTO
- `src/main/index.ts`：`utilityProcess` broker、最近项目、Workbench IPC 与 Electron 安全边界
- `src/main/workbench-manifest.ts`：严格 manifest 发现、semver 与规范路径校验
- `src/main/workbench-host.ts`：Workbench registry、surface 生命周期与 sandboxed view 创建
- `src/main/workbench-host-state.ts`：启用状态、generation、面板 JSON 状态与崩溃策略
- `src/main/browser-manager.ts`：原生 Browser tab/profile、动作、生命周期与页面隔离
- `src/preload/plugin.ts`：sandboxed panel 的最小 `window.piPlugin` bridge
- `src/renderer/src/components/Conversation.tsx`：对话、状态、Context、Queue 与 composer
- `src/renderer/src/components/BrowserPane.tsx`：Browser chrome 与共享控制状态
- `src/renderer/src/components/Workbench.tsx`：registry rail、设置、first-party/native/plugin surface 路由
- `src/renderer/src/components/SandboxedPluginPane.tsx`：plugin view 可见性与 bounds 协调
