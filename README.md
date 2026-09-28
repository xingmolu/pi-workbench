# Pi Desktop

Pi Desktop 是一个本地 Electron + React 客户端，直接嵌入
`@earendil-works/pi-coding-agent`。它不复制 Pi 的会话或凭证。

当前 MVP 覆盖 [DESIGN.md](./DESIGN.md) §9 的步骤 1、2、2b、2c、3 和 3b：

- 文档流对话节点：user、assistant Markdown、think、tool；
- 代码块与文件预览的 Shiki 语法高亮、原文复制/换行，表格保护复制、系统 CSV 保存和冻结内容的分页只读预览；
- composer：Open / Ask、账号 → 模型、ContextMeter、Send / Stop / Queue；
- 文本上下文：加号选择文件或 Files「添加到对话」，快照附件、失败保留和 canonical 历史展开；
- 会话标题、运行/待确认/错误状态、同会话模型切换，以及完整 follow-up 队列；
- 同项目多会话后台执行、独立 Stop/审批/队列、运行时侧栏状态与自由切换（最多 8 个常驻会话）；
- 真实 Pi usage、context 和本次运行期时序指标，不估算费用；
- Codex（ChatGPT Plus / Pro）浏览器登录与 device code；
- Pi 多账号 provider 别名 `openai-codex-<slug>`；
- 自定义 OpenAI Chat Completions / Responses、Anthropic Messages 端点设置；
- 按 canonical session cwd 隔离的 Pi JSONL 会话列表、新建与恢复（保留 CLI 目录编码）；
- 已保存会话重命名、跨项目全量标题搜索（⌘/Ctrl+K）和当前对话的问题导航；
- 已保存会话当前历史分叉为新会话、来源导航与原会话草稿保留；
- 左下角独立设置弹窗：常规、外观、账号与模型、Codex 订阅额度、手机网关（回环 + 局域网配对码 + Tailscale Serve）、Skills、MCP 服务器与 Desktop 插件；
- Skills 已加载技能库：设置中搜索与只读详情，输入框键入 `/` 搜索并插入原生技能命令；
- Main 发布的 typed Workbench registry：顶部开关、空态纵向工具列表、已打开工具标签与 `+` 菜单；默认折叠为零宽，展开后可拖动或用方向键调整，折叠再展开保留本窗口的宽度；
- Files 已支持当前项目的只读目录浏览、文件名搜索、隐藏文件开关、刷新、UTF-8 文本预览与复制；
  Review 已支持只读 Git 未暂存、已暂存和明确选择基准的分支差异；Terminal 提供独立的真实用户 PTY、多标签页和显式创建/结束。Browser 是 Main 持有的原生
  `WebContentsView`，支持多标签页、按 project 隔离的持久 profile 和用户/agent 共享控制；
- 本地 `sandboxed-web` Workbench 插件：严格 manifest、独立 `WebContentsView`、窄化
  `window.piPlugin` bridge、按 project 状态和崩溃隔离；
- Pi `browser` 工具：snapshot/ref、click/fill/select、导航、wait、screenshot 与 Stop。
- 手机对话面：本机回环网关、一次性配对、局域网 QR、可撤销设备 grant；远程主路为 Tailscale Serve（Cloudflare Quick Tunnel 可选）。

Files 不支持编辑、重命名、删除或自动附加到对话；仅预览不超过 1 MiB 的 UTF-8 文本，二进制/非 UTF-8 内容会在检测后拒绝预览，符号链接和 Git 内部路径禁止访问。搜索仅匹配文件名，并跳过依赖与构建目录；达到扫描上限会提示结果不完整。这是应用级只读路径边界，不是针对恶意本机进程的 OS sandbox。

表格默认文本保护模式会在每格前添加单引号（包括表头），这是明确的数据变更，不保证所有表格软件的公式安全；原始值模式需显式选择。CSV 保存由系统对话框指定路径，取消不报成功；复制和保存各自反馈结果。最多 10,000 单元格、200 列、1 MiB，超额拒绝而不截断；预览每次加载 200 行。超过 200 KiB 的单块 Markdown 显示完整纯文本，可执行 artifact 未实现。

文本文件需明确点击加号或 Files「添加到对话」，最多 4 个，单文件 1 MiB、合计 2 MiB；只支持普通 UTF-8 文本，含无扩展名文本和配置文件。发送的是选取时的内容快照，不是只有文件名；原文件之后修改或删除不改变该快照。未发送附件在切换会话后清除，30 分钟过期在下次操作时校验。附件暂只支持空闲时发送，忙碌时保留文件且仍可 Stop；图片、拖放、粘贴和 PDF/Office 解析尚未实现。

附件发送失败时保留草稿；结果未知时只能查询原发送，不自动重发。Pi 预检接受不等于落盘或回答成功。已发送文本保存在 Pi 自己的 canonical 消息中，重开会话可展开查看，不另存 transcript。SDK 内部预检接缝固定到已验证的 `0.84.4`，升级需重新运行兼容回归。

会话目录编码可能碰撞（例如 `a-b` 与 `a/b`）。Host 按 SDK 公共会话信息的绝对 cwd 过滤列表及自动恢复，显式打开还校验路径归属；创建项目服务前再次检查实际 manager cwd。

左栏按项目分组浏览 Pi 历史，支持折叠、项目内新会话、直接打开其他项目的会话和每批 50 条的“显示更多”。跨项目切换保留各自输入草稿；失败在目标项目下提示并显式重试。左栏最多显示 100 个项目，截断会提示；全局搜索在这些显示上限之前查询 SDK 发现的所有会话标题，每次最多返回 50 项并提示缩小范围，不搜索正文。⌘/Ctrl+K 或左栏搜索入口打开命令面板，还可选择已有项目新建会话、打开文件夹、跳转当前项目文件搜索。运行中可搜索、新建和切换会话，后台执行不受切换影响；不存在的项目目录不能用于新建。含 JSONL 文件链接的目录保守跳过并提示，不读取链接目标。

多会话运行边界：最多 8 个常驻会话，只有空闲、已保存且结果已确认的会话可以回收。新会话继承来源账号/模型，历史会话保持自身选择；不做自动账号切换。Browser 只接受当前前台会话的 agent 操作，切换会取消旧浏览器操作。全局账号/端点/MCP 修改要求所有会话空闲。同项目内置写入、bash 和 MCP 调用按锁串行，读取与生成可并行；未知 MCP 结果保持锁到所属进程退出。它不能保证远程 MCP 或外部/脱离的进程停止，不是 OS 沙箱。

回复下方提供复制、分叉、赞、踩图标；最近用户问题可编辑。消息分叉保留截至所选完成回复的历史和当时模型，不携带后续轮次；顶栏仍可分叉当前路径。原草稿留在来源，子会话不自动发送，文件/终端操作不会撤销。模型不可用时保留内容并锁住发送。赞踩仅记录在 Pi 会话的本地元数据中，可撤销、重开恢复，不发送给服务商。结果未知时重新读取，不直接重试；助手重试尚未实现。

当前源码提供最近问题的「编辑问题」入口（已通过独立规格与质量审查）：独立编辑框只改文字，保留原文本快照和图片，不覆盖普通输入框草稿。取消不发送；明确发送后在同一会话从原问题之前继续，旧记录仍保留，但暂不提供旧分支切换器。文件和终端操作不会撤销，工具可能再次执行。发送结果未知时只查询，不直接重发；引擎断开后使用编辑区重连入口核对历史。附件增删、任意历史编辑和助手重试不在当前实现内。

Git 写入、Trace 和自动 worktree / agent 编排仍是后续边界。插件
marketplace、签名、自动更新、远端 UI 入口、第三方 native/module、通用 agent command
绑定和 MCP Apps 也明确延期。`@` 文件/会话引用、
图片粘贴附件、用户可拖内容轴及 `~/.codex/auth.json` 便利导入也明确延期。

设置中的「自定义端点」无需先选项目，直接管理 Pi CLI 共用的 `~/.pi/agent/models.json` 与 `auth.json`，影响所有工作区。明确选择协议、填写显示名称、服务地址、API Key 和每行一个模型 ID；新端点不会自动切换当前账号。地址只允许 HTTPS 或显式本机 HTTP，后者会提示明文传输风险。模型移除须确认；高级配置只读，损坏文件不能用空配置覆盖。密码不进入 Renderer 全局 store，表单值在提交/关闭时清空；编辑留空保留原凭证，不回显旧 key。已出现在 `models.json` 且 Pi 运行时认为可用的 CLI provider（即使设置里标记为只读）可在 composer 中选择账号和模型；缺少可用认证的端点仍不能发送。

设置弹窗按基础设置、连接与 Agent 能力分类。打开时保留左栏宽度、对话草稿和工作台选择；原生 Browser/插件临时隐藏，关闭恢复。Codex 登录仍调用 Pi 的公开登录能力。每个 Codex 主账号/别名可显式刷新订阅额度，只展示账号服务返回的窗口、百分比和重置时间；不可读取不等于零额度。该查询依赖 Codex 当前使用的非稳定公开 API 合同的账号服务端点，不保证持续可用，不估算费用或次数。认证只在 Host 解析，重新登录后丢弃旧额度。

MCP 使用 Pi 官方扩展机制和官方 `@modelcontextprotocol/sdk`，不是 Pi 原生内置 MCP。设置里可新增/编辑/启停 stdio 与 Streamable HTTP 服务器；配置存于 `~/.pi/agent/mcp.json` 的 `mcpServers`，0600 原子替换。`piDesktop.trustedServers` 记录用户确认的精确配置摘要；已有或外部修改的配置必须重新确认，不自动发现项目/其他应用服务器。环境变量与请求头只展示字段名，编辑留空保留已有值。配置是本机秘密文件，不是钥匙串；不要把 token 放在命令参数或 URL。

需要登录的 Streamable HTTP 服务器走 MCP 标准 OAuth（官方 SDK 负责资源/授权服务器发现、动态客户端注册、PKCE 与刷新）：连接时收到 401 会显示「需要登录」，只有在设置里点「登录」才在系统浏览器打开授权页，并由一次性的 `127.0.0.1` 回调（校验 state，5 分钟超时）收回授权码；后台连接只刷新已有令牌，从不自行注册或打开浏览器。可选填写预注册的客户端 ID/密钥、授权范围与固定回调端口；配置了 `Authorization` 请求头的服务器不使用 OAuth。令牌存于 `~/.pi/agent/mcp-oauth.json`（0600，按服务器名 + URL 隔离，改 URL 即失效），可随时退出登录；配置的请求头只发给 MCP 地址本身，发现/令牌请求只允许 HTTPS 或本机地址且禁止重定向。

Agent 通过 `mcp` 工具依次 list / describe / call。Ask 对每次实际调用确认，Open 直接执行；启用服务器本身允许其启动代码以本机用户权限运行，Ask 不是进程沙箱。停止调用关闭连接，需显式重新连接。保存仅允许空闲态，不替换会话或另存 transcript。当前仅支持文本工具结果，不支持旧 SSE、资源/提示模板、MCP Apps、JSON 批量导入；最多 16 个服务器、每服 128 个工具。高级或损坏配置保守只读。

端点保存分别显示配置、凭据和运行时结果，不假装两个文件是一个事务。部分保存或结果不确定时先核对列表与登录状态，不自动重试；“刷新列表”只读配置，不修复运行时。当前模型被移除、配置发生漂移或运行时同步失败时，Host 和 composer 都阻止发送；历史保留，要求明确恢复或重选，不自动 failover。保存与登录启动/别名重载串行，进行中的 OAuth 不会被表单取消。

用户终端无需 Pi 登录：点击工作台「终端」后显式新建，以所选项目为初始 cwd 启动本机用户 shell。它具有当前 OS 用户权限，不是项目沙箱，不受 Agent Ask/Open 审批；输入、输出与剪贴板内容不会自动进入模型或 Pi transcript，只有你选中后点「添加到对话」的文字会作为草稿加入输入框。终端继承用户环境（含 `SSH_AUTH_SOCK`、代理、语言与版本管理器路径），去掉应用自身的内部变量，并声明 `COLORTERM=truecolor`；shell 依次取登录 shell、`$SHELL`、zsh、bash、sh。隐藏面板、切换标签或项目保留同一 xterm/parser/PTY；隐藏终端继续解析输出并在 write 完成后 ACK。每项目最多 4 个、全局最多 8 个运行终端，Renderer 最多保留 8 个屏幕（含已退出屏幕），达到上限须先显式关闭一个；每屏幕 scrollback 2,000 行。

若结束期间切换项目，已退出终端的屏幕/记录仍计入上述 8 个保留额度，返回所属项目后继续完成关闭；没有额外无界的待删除缓存。已退出屏幕仍可选择、复制和滚动。Renderer reload 后历史屏幕不可恢复，管理记录不冒充保留屏幕。

粘贴上限 1 MiB UTF-8，大段内容分块、按主进程每秒输入额度匀速发送，与其后的键入保持顺序。shell 开启 bracketed paste 时多行文本直接粘贴；未开启时含换行先预览确认；转义、NUL、DEL 与 C1 控制字符始终先确认。输入只限制 shell 尚未读取的积压（8 MiB），不再按终端累计输入量失败。关闭终端时，若 shell 空闲（前台没有其他程序）直接结束，否则先确认；关闭会请求结束 shell/常规任务，不能保证回收 detached daemon；替代终端必须等待实际退出确认。⌘/Ctrl 点击打开网址（系统浏览器）或项目内文件路径（如 `src/cart.ts:12`，在「文件」中打开）；⌘F 搜索当前终端。OSC 标题只作为有界非可信文字；OSC52 被禁用，OSC8 仅在 ⌘/Ctrl 点击时打开 http(s) 链接。Renderer reload 后仅显示管理态「终端进程仍在，屏幕状态未恢复」，需明确结束并新建，不自动重放命令或假恢复 TUI。无损 reload/TUI 恢复、原生锁屏后键盘/剪贴板验收、签名安装包验证仍未完成。

## 设置与 Skills 技能

过程说明和流式文本不显示完整回复操作栏；已完成的 canonical 回复只在最后一个文本块显示一次复制/分叉/赞踩，用户问题与代码/表格内复制不受影响。工作台分栏复用 shadcn Resizable 同源的 `react-resizable-panels`，不是自研拖拽器；调整时保留对话、终端和原生浏览器/插件状态。

设置按「基础设置 / Agent 能力」分组。常规支持 Enter 或 ⌘/Ctrl+Enter 发送、工作过程默认紧凑/展开、底部用量显示；外观支持对话正文与代码字号、代码默认换行和减少动效。偏好只存 Desktop 的 `pi-desktop-preferences`，保存确认后生效，恢复默认不改 Pi 会话、账号、权限或配置。读取偏好前不使用默认快捷键擅自发送，显式发送按钮仍可用。

单个代码块或工作组的手动开合选择优先，待处理审批保持可见，错误详情默认展开但可手动收起；隐藏用量不停止统计，也不隐藏 ContextMeter。字号不是窗口缩放，不影响终端和网页。外观支持深色、浅色、跟随系统，保存后立即生效并跨重启记住；旧设置缺少主题字段时保留深色和原有偏好。对话、设置、文件、Git Diff 与终端同步换色，高亮复用 GitHub 深浅配色，终端不重建进程或清空输出。网页/第三方插件自行处理配色，不强制反色；不修改操作系统设置。

设置中的「Skills 技能」显示当前 Pi session 实际已加载的资源，可按名称/简介和来源范围筛选，查看最多 64 KiB 的普通 UTF-8 技能文件。预览只接受 Host 当前目录的 opaque ID，不提供任意路径读取。仅手动调用不是禁用：这类技能不会出现在模型可发现列表中，但仍可明确调用。

在输入框键入 `/` 即可唤起技能列表，无额外常驻按钮。上下键选择、Enter 插入 `/skill:name `、Esc 关闭；选中技能不会发送，原有请求参数会保留。设置中的插入动作则将命令放在完整现有草稿之前。Shift+Enter 换行，中文输入法选词不触发发送。技能由 Pi 自己在发送时展开，不另造展开器或 transcript。

刷新只重新读取当前已加载列表，不扫描或 reload 扩展；新建技能后需要重新打开项目。首版不提供安装、编辑、删除、市场或通用启停开关。技能命令暂不能和文本附件一起发送，界面会明确提示并保留输入。

## 本地运行

macOS Apple Silicon 上安装依赖并启动开发环境：

```bash
npm ci
npm run rebuild:pty
npm run smoke:pty
npm run dev
```

PTY 的 native 准备不可省略：干净安装的 node-pty 1.1.0 预构建 helper 不可执行，须使用官方 electron-rebuild 定向重建。当前脚本固定 Electron 44.1.0 / arm64，需要 Xcode Command Line Tools（含 macOS SDK、clang）与 Python；已验证 Xcode 26.6 / SDK 26.5 / Python 3.9.6。

开发时 Renderer 默认运行在 `http://127.0.0.1:43123`。
`npm run dev` 和 `npm start` 会先编译 macOS Computer Use 的 Swift helper，
需要 Xcode Command Line Tools。直接启动 Electron 时请先执行
`npm run build:native:mac`。编译成功不代表已获得辅助功能权限；请在实际运行的
Pi Desktop 中检查授权，并保持桌面解锁。

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

MCP 包内依赖可另外用 `npx electron scripts/mcp-bundle-smoke.cjs "/absolute/path/Pi Desktop.app/Contents/Resources"` 验证。它通过开发 Electron 的 utilityProcess 加载包内 Agent Host、官方 SDK 并执行隔离 `mcp:list`；不启动生产应用入口、不读取真实 Pi 配置，也不代替真实服务商验收。
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
5. 输入框里的权限按钮提供三档，按项目记住，重启后保持：
   - 请求批准：bash、powershell、write、edit 和网页交互前询问；
   - 帮我批准：自动批准项目内的 write / edit（每轮可撤销）和常规命令（如 `ls`、`git status`、
     `git diff`、`npm test`、`cargo build`），项目外写入、组合命令、`rm`、`git push`、安装依赖、
     联网下载等仍会询问。这是静态规则判断，不是 OS sandbox；`npm run` 等会执行项目脚本；
   - 完全访问权限：不再询问。
   Computer Use 每次都询问，MCP 仅在完全访问下免确认。「自定义规则」可保存始终允许的命令前缀和
   「自动允许编辑项目内文件」，在请求批准和帮我批准下都生效；确认卡片上的「总是允许 …」会保存规则并允许本次操作。
   命令规则按开头的完整单词匹配（`npm test` 允许 `npm test -- x`，不允许 `npm testing`）；
   含 `;`、`&`、`|`、重定向、`$`、反引号、括号、反斜杠或换行的命令始终需要确认。
   编辑规则只放行解析符号链接后仍位于项目内的路径。档位和规则保存在
   `~/.pi/agent/pi-desktop/permissions.json`，不写入项目目录；新项目默认请求批准。
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

## 文件改动与撤销

Pi 通过 write / edit 工具修改文件时，对话里的工具行直接显示项目相对路径、增删行数和语法高亮 diff；Ask 模式下的确认卡片展示将要写入的改动，而不是原始参数。执行前的 diff 来自模型参数，无法定位真实行号，因此隐藏行号；执行成功后改用 Pi 返回的实际 patch。单个 patch 超过 200,000 字符时只显示行数。

每轮结束后显示本轮改动过的文件汇总，可逐个展开 diff，并可「撤销」：把这些文件还原到该轮开始之前。撤销某一轮会一并撤销之后各轮对文件的改动（磁盘只有一条时间线）；Pi 新建的文件会被删除。检查点只覆盖 write / edit 工具：bash 等命令产生的改动不会被记录或还原，对话记录也保持不变。

检查点在 Pi 获得项目写锁之后、写入之前保存原文件，存放在 `~/.pi/agent/pi-desktop/checkpoints/<session-id>/`。超过 4 MiB 的文件、目录和符号链接不保存原文，撤销时列为「无法还原」。撤销前会比较文件当前内容与 Pi 最后一次写入的结果；之后被手动或其他程序改动过的文件需要明确选择「覆盖并撤销」。撤销只在会话空闲且没有待确认操作时可用。

## Git Review

右栏“审查”提供只读 Git 差异：未暂存为 index→working tree，已暂存为 HEAD→index（支持尚无提交的仓库），分支为用户明确选择的本地或远端引用与 HEAD 的 merge-base→HEAD，只含已提交内容；不联网获取引用。分支清单捕获 commit OID，工作区/暂存区内容则在每次请求时读取，并非原子快照。

文件逐项加载，默认统一视图，可切为分栏。未跟踪文件单列，复用 Files 的有界只读预览；冒号/反斜杠等 Files 不支持的路径仍列出，但不可预览。二进制、冲突、子模块、类型变化和空差异有独立说明。解析失败、非 UTF-8 字节转义内容，或超过 2,000 行 / 200,000 字符的 patch 显示完整“原始差异”，不静默截断；Main 输出预算超限则明确报错。

维护提示：Diff 使用 @pierre/diffs 1.4.2 的语法与词级高亮，保持完整原始差异切换；当前采用有界主线程 JS 高亮，没有启用 worker pool 或虚拟化，调整回退阈值时必须同时做交互性能回归。

切模式、文件、项目或关闭工具标签会丢弃迟到的 Renderer 响应；Main 仅在项目切换/引擎退出时撤销能力并终止相应 Git 进程。引擎断开后清空差异，重连刷新。没有暂存、丢弃、提交、checkout、fetch 或 push 控件；仍不做 rename detection、Last turn 和冲突编辑。检测到有效 clean/process 过滤器配置时，扫描会明确拒绝；该边界不是抵御恶意本机进程或动态配置竞态的 OS sandbox。

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
- `src/renderer/src/components/Workbench.tsx`：registry rail、first-party/native/plugin surface 路由
- `src/renderer/src/components/SettingsDialog.tsx`：独立设置弹窗、账号与模型/MCP/Desktop 插件分类
- `src/agent-host/mcp-runtime.ts`：官方 MCP SDK 与 Pi 工具、审批、取消桥
- `src/agent-host/account-quota.ts`：所选 Codex 身份的真实额度白名单投影
- `src/renderer/src/components/SandboxedPluginPane.tsx`：plugin view 可见性与 bounds 协调
