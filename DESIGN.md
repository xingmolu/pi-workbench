# Pi Desktop UI 设计

Pi Desktop 是基于 `@earendil-works/pi-coding-agent` 的本地桌面客户端。界面以对话为主，左侧组织项目与会话，右侧按需展示文件、差异、终端和浏览器。每个区域都应反映真实运行状态，不展示尚未实现的操作入口。

## 1. 产品目标

- 项目与会话是导航和恢复的基本单位；切换会话不会中断其他会话的运行。
- 对话按用户、助手、思考、工具、审批和错误呈现，保留完整历史与明确的执行状态。
- 输入区集中显示权限、账号、模型、上下文和发送状态；运行时可 Stop 或排队后续消息。
- 工作台默认收起，只在用户需要查看证据或操作工具时展开。
- Renderer 只消费受验证的状态与能力，不直接读取 Pi 凭证、会话文件或系统资源。

## 2. 产品结构：三栏，不是两栏

- **Sidebar（Project + Session）**：Project = 文件夹 = Pi cwd。Session 挂在 project 下（标题 + 相对时间，运行蓝点，待确认琥珀点）。`Cmd+B` 收成 56px rail。文件树不在左栏。

2026-09-15 侧栏可读性：项目／会话主文字 14px，日期和辅助文字 12px；使用侧栏语义颜色 `--sidebar-text` / `--sidebar-secondary`，选中底色 `--sidebar-selected`，不整体提亮对话画布。每项目默认显示最近 5 条；当前会话、运行／待审批／失败的常驻会话额外保留，明确“展开显示／收起历史”，展开后沿用原 50 条分页。运行状态与日期择一显示，避免挤压标题。同名项目显示最短可区分路径后缀，完整路径保留在 tooltip；失效目录保留提示与历史，不因样式调整删除项目或记录。

会话身份以 SDK 的 session cwd 和经校验的项目归属为准，不能把 CLI 编码目录等同于项目身份。列表与自动恢复过滤 SDK 公共 `SessionInfo.cwd`，要求绝对路径；当前归属检查优先比较 `realpath`，路径不可解析时回退 `resolve`，不回退进程 cwd。全局搜索保留 SDK 来源 cwd 与原 session path，打开时仍由 Main/Host 重新校验归属；项目目录列表对可用目录使用 canonical realpath。显式打开要求路径属于过滤后的候选，runtime factory 在创建 cwd 相关 services 前核验实际 manager cwd 与 factory cwd 均属于捕获的项目。保持 CLI 目录编码和 SDK 公共 open/create；legacy open 可能先迁移文件，这不是对外部恶意并发修改的 CAS 屏障。

- **Conversation**：使用文档流节点，始终保留在中栏。MVP 使用响应式内容轴；680–920px 用户可拖宽度是后续目标，本轮未实现。
- **Workbench**：采用顶部显示/隐藏开关，默认零宽折叠，无常驻 mode rail。展开且没有已打开工具时居中显示纵向 registry 列表；打开后只显示已打开 contribution 的标签及 `+` 纵向菜单。每个 contribution 一个标签，保留浏览器/终端内部多标签；关闭最后一个工具返回空态。隐藏工作台或关闭外层终端标签不结束 PTY，结束仍需显式操作。Browser、Files、只读 Git Review、用户 Terminal 与 sandboxed plugin 都是真实 surface；不注册占位 Trace/侧边聊天。长列表滚动、长标签省略并保留完整名称。分栏使用 shadcn Resizable 同源的 react-resizable-panels，支持拖拽、键盘调整及同窗口宽度记忆；拖拽、设置弹窗和 `+` 菜单覆盖时隐藏原生 Browser/plugin view，结束后恢复并同步位置/尺寸，不销毁服务状态。设置打开时忽略后台 reveal。macOS 原生隐藏标题栏，保留红绿灯，三栏顶部 48px；窄对话区图标化既有操作，保留状态并将重复模型/权限信息留给 composer。跨重启、按工作区记宽度和 tab 恢复后做。

过程 assistant 文本和 streaming 块没有完整回复操作栏。Host 完成标识 canonicalEntryId 存在时，仅同一回复的最后文本块显示一次；历史已完成回复不因后续 busy 消失。用户问题、代码和表格自身复制不变。

当前先保证对话、会话、账号、模型、审批、Context 和 Queue 的状态可信，不用空 Workbench 提前占据 360px。

空态：没选 project 时，中间对话区显示唯一主动作「选择工作区」。

## 3. 对话区

2026-09-11 会话发现补充：对话顶栏提供“重命名会话”和“问题导航”两个紧凑文字按钮，窄窗口将模型、状态和运行权限移到下一行，保留核心入口。重命名使用局部 Popover 表单，共享名称校验，保存期间禁用重复提交；按会话身份和代际关闭旧表单，迟到响应不能影响新表单。只有 canonical 写入完成才更新标题，写盘失败复用显式引擎重连恢复已保存名称。

多项目导航：左栏用项目分组与缩进单行会话替代单工作区列表，项目内可新建、折叠、直接打开目标会话；已加载标题搜索不伪称全库搜索，50 条分页、100 项目截断明确说明。只读目录使用公开 SDK 读取指定 sessions 根与一级 bucket，依据返回 cwd 归组而不解码 bucket；Main 只保存成功打开路径的 recentProjects。跨项目打开以 cwd/sessionPath/源身份单个串行意图执行，保留每会话草稿；局部错误与显式重试不被折叠或搜索遮住。文件链接目录保守跳过并提示，分页扫描成本尚未专项优化。

当前路径分叉：顶栏独立确认入口写明未发送草稿不复制、文件与终端操作不撤销。Host 只允许已保存普通文件、当前路径有助手回复且无运行/等待操作的会话，验证提交时的 session/generation/leaf 后调用公开 SDK at-fork。子会话沿用 canonical 模型，来源草稿保留、子会话输入为空；侧栏使用来源元数据标记“分叉”，不为区分标题额外改写历史。来源路径只有在同项目 SDK 列表内才可导航。准备失败与可能已创建子会话的执行失败分别提示，失败后关闭核对再重新确认；不自动重试或删除可能留下的子文件。

最近问题编辑（已通过独立审查）：仅当前分支最近 canonical user 展示入口，纯图片、首条问题和 user leaf 不遗漏。独立编辑草稿与普通 composer 分离，保留 Host 捕获的文本快照和图片，只修改问题文字。明确发送才以公开 SDK 父节点导航与扩展事件组合重新定位，保留当前模型/thinking，随后在原 JSONL 追加新路径；旧 entries 不删除，文件操作不回滚。发送 ID 去重，unknown 不自动重发；写盘不一致断连后，编辑区提供明确重连核对，保留两份草稿。编辑附件增删、任意历史编辑、旧分支选择、助手重试仍未实现。

侧栏标题搜索只作用于当前工作区已加载的会话，不增加全文索引；未选项目、无历史和无匹配结果分别展示。问题导航按当前 user 节点顺序列出摘要，长摘要省略并保留完整 tooltip；选择后关闭菜单、聚焦原问题并滚动到该处，Escape 则返回入口焦点。此动作只改变阅读位置，不切换 leaf、不修改模型或 transcript。既有中文字体、画布色、无头像与无消息时间戳继续保持。隔离 Electron 的常规/960px 截图用于布局验证，原生包验收仍待解锁后独立执行。

2026-09-11 打包验收修正：主动取消独立为 `stopped`，按 Pi canonical `stopReason` 投影并保留部分输出；同一次模型失败只显示一个错误。审批除 inline 卡片外，在 composer 上方提供显式跳转，避免滚动位置让等待操作不可见。自动标题使用首行且最多 48 个 Unicode code point，显式命名不改写。表格增加单元格间距和横向滚动；Think Compact 仅显示折叠状态，正文展开后渲染 Markdown，不泄露原始格式标记到摘要。中断缺失 usage 不计算零速度。

节点：user / think / tool / assistant / error / stopped / model / compaction。模型与压缩记录是画布上的低干扰文档分隔线，12px 灰色正文、无头像和消息时间戳，不参与 Tab 顺序；长 provider/model ID 自动换行，完整文字不依赖当前模型下拉框。首次标为“模型”，后续标为“模型切换”；压缩只提示“上下文已压缩，历史消息仍保留”。当前分支在压缩前的问答继续展示和定位，其他分支不混入；内部压缩摘要不冒充助手消息。

工具卡片 intent：bash→terminal，read/ls→read，grep/find→search，write/edit→diff。工具结果按 canonical 调用出现次序关联；重复 `toolCallId` 不覆盖旧卡片，实时审批只作用于当前调用。工具状态为 `queued / awaiting-approval / running / success / error / blocked`；运行中的 active session 派生状态由侧栏和对话头共同读取。

Composer：`+` · 权限芯片（Open / Ask）· 账号 · 模型 · ContextMeter · 蓝色圆 Send（Send↔Stop↔Queue）。Ask / Open 是本次本地运行期审批策略，重启回 Ask，不等同于 OS sandbox 或持久 allow/deny 规则。运行中发送进入 Pi follow-up 队列；MVP 展示完整队列并支持清空全部，单项编辑、删除和 steer 后做。Context popover 只展示 Pi `getSessionStats()` 的 context tokens/window 与累计 input/output/cache，以及 Host 本次运行实测；缺失值显示未知，不伪造分类或美元费用。

窄内容轴使用 composer 容器宽度而非仅按窗口断点适配：600px 及以下，第一行是添加、权限、账号，第二行是模型、Context、队列和 Send；DOM/Tab 顺序不变。模型入口不再因窄窗口隐藏。大于 600px 保留原单行布局；有无队列不改变第二行主要控件的位置。该调整不等同于可拖分栏或项目宽度记忆，后者仍待完成。

文本附件：加号原生选择或 Files 显式添加，Main 持有最多 4 个/单项 1 MiB/合计 2 MiB 的不可变 UTF-8 快照，Renderer 仅持有描述符。chip 展示文件名、类型、大小和快照说明，支持移除；选取与发送受窗口、项目、会话和 generation 约束。附件只在 idle 发送，忙碌时仍提供 Stop。接受/拒绝/未知回执独立于模型最终回答；拒绝保留可修改草稿，未知锁住同一提交并允许查询，迟到成功不能清空新输入。确定性的文件上下文放进 Pi canonical 文本消息；历史以转义纯文本折叠展开，标题和问题导航只展示用户问题或文件名摘要。输入包装不是 prompt-injection 安全屏障。图片/拖放/粘贴和完整附件队列继续延期。

## 4. 右侧 Workbench

Workbench 已从 Renderer 写死的 mode union 改为 Main-owned contribution registry。Main 发布可序列化的 plugin/contribution/snapshot DTO；主 Renderer 只负责 rail、设置和 surface chrome，不接收插件 root 或 entry path。内置 Files / Review / Terminal / Browser 也走同一 registry。Files 已提供当前项目的只读目录与单文件预览；Terminal 是独立的**用户 PTY**（Pi bash 仍走对话卡片）。跟随产物继续克制：不因每次 write 切 Review。

Terminal 采用持久挂载的 stage 和独立 controller，沿用中文、深灰画布与蓝色状态点。只有明确点击新建才启动本机 shell；无需 Pi 登录。按项目展示 tabs，折叠/切模式/切项目不销毁 emulator DOM、parser 或 PTY，Browser/plugin 则继续按原有逻辑卸载，避免 native view 盖住终端。每项目 4 个、全局 8 个运行终端；Renderer 最多保留 8 个屏幕（含已退出屏幕），第 9 个须先显式关闭旧终端；单屏 scrollback 2,000 行。标题限制 64 code point 且去除控制及方向覆盖字符，只影响展示。

隐藏终端保持解析和 write-callback ACK，也继续向原 capability 回复 DSR/DA。DOM 输入通过 inert/blur/capture guard 隔离；文档级鼠标拖动事件用标准 Event.eventPhase 判断同步 DOM 来源，拒绝隐藏终端的用户报告，不分类 VT 字节或关闭 disableStdin。危险粘贴含控制字符可读预览，8 KiB UTF-8 整体上限；确认才交给 xterm.paste，取消或上下文切换不发送。终止弹层绑定原项目、terminalId、generation、connectionEpoch；退出未确认时不会创建替代 shell。OSC52 禁用，OSC8 不自动或点击打开外部应用。

页面 reload 只保留后端进程管理能力，显式显示「终端进程仍在，屏幕状态未恢复」，不能继续输入；结束并新建需要确认且等待实际 shell 退出。不会通过原始尾部、Ctrl-L、重放命令或自动启动 shell 假装无损恢复。真实 OS shell 不属于 Agent Ask 审批或项目沙箱；终端内容不进入模型。无损 reload/TUI 状态恢复、真实 Mac 输入法/焦点/剪贴板及签名包验收仍是独立未完成门槛。

关闭期间切换项目时，已确认退出的 owned entry 与 emulator 保留至返回原项目同步关闭，仍计入同一 8 个保留额度；管理态待同步记录也占额度。没有额外待删除 tombstone 缓存，达到额度时先要求完成已有关闭。迟到关闭只能移除原终端；用户后来选择的另一个 tab 不会被改选。已退出屏幕允许选择、复制和滚动，但不再向 PTY 发送输入。

Git Review 提供“未暂存 / 已暂存 / 分支”三种只读范围，分别为 index→working tree、HEAD→index（支持 unborn）、用户明确选定引用与 HEAD 的 merge-base→HEAD。基准下拉区分本地与远端引用，不猜 main/master，也不 fetch。未跟踪文件与 tracked diff 分组，复用 Files 有界预览；逐文件加载并保留键盘焦点。采用 @pierre/diffs 1.4.2 的统一/分栏、语法和词级差异高亮，默认统一；始终可切换原始差异，长行横向滚动并显示非纯颜色的增删标记。只解析 patch，不额外获取完整旧/新文件，因此不承诺缺失上下文的多行词法准确度。当前有界主线程 JS 高亮，无 worker pool/虚拟化；解析失败、rawOnly 字节转义、大于 2,000 行或 200,000 字符显示完整原始文本；二进制/冲突/子模块/类型变化有明示，类型 patch 保留原文。切模式/文件通过 epoch 抑制迟到响应，不宣称取消 Main 进程；项目切换与引擎退出撤销 Main 能力，断线不展示旧差异，重连重新加载。未实现 Git 写入、Last turn、rename detection、冲突编辑。过滤器仓库明确拒绝扫描，安全边界不包含恶意本机进程或动态配置竞态。

代码块和 Files 文本预览共用 Shiki 4.4.3：受控语言集合、GitHub 深浅主题、一个本地 JS regex worker。先提取原文再渲染 React tokens，复制不经过高亮 DOM；流式阶段纯文本，完成后异步着色，迟到结果不覆盖新内容或新主题。超过 100,000 字符或单行 4,000 字符保持完整原文；缓存键包含主题、语言和源码，至多 24 项/500,000 原文字符，同时最多 16 个请求，超量回退纯文本。未知语言回退纯文本，不注入消息 HTML、不开放 Node 或放宽 CSP。

Files 使用原生 disclosure 按钮懒加载目录，文件名搜索与隐藏文件开关都受 Main 项目边界约束；搜索跳过依赖和构建目录，截断明确提示。预览限 1 MiB UTF-8 普通文件，以转义纯文本呈现并容纳长行横向滚动，可换行、复制内容/相对路径、刷新或返回原目录。二进制、超限、权限错误有独立反馈，符号链接不可用；切换项目清空目录、搜索与预览，在途旧响应不能回填。无编辑、删除、重命名或自动对话附件。

Browser 已实现为 Main 持有的 native `WebContentsView`：按 project 隔离持久 profile、多标签页、窄化 typed action、短寿命 snapshot ref，以及用户/agent 同页共享控制。Renderer 不持有 Node、Pi、CDP 或任意 eval；Agent Host 只能经 Main capability bridge 请求固定操作。Browser 网页内容明确标记为不可信，保持 sandbox、context isolation、关闭 Node integration；权限默认拒绝、下载阻止、popup 转受管 tab、远端仅 HTTPS（localhost 允许 HTTP）。用户操作优先并会取消 agent 在途动作，控制条提供 Stop。Open / Ask 继续决定普通 agent 交互是否进入批准卡；上传、下载、cookie/凭证导出和任意脚本执行不在工具面内。

第三方 Desktop UI 当前只开放包内静态 `sandboxed-web` surface。用户插件由 `~/.pi/agent/desktop-plugins/<id>/pi-desktop.json` 手工发现；与 Pi package 并置的 manifest 只从 Agent Host 当前实际加载的 package-scoped Skill/Extension root 发现，不扫描任意 project。Main 在 manifest discovery 前按 canonical realpath 合并两类 root，scope 以 project 优先并对可执行 Pi resource 标记取 OR，因此同目录或符号链接别名不会形成伪重复、也不会隐藏代码信任警告。root、entry、Pi `baseDir` 与 loader 原始 `source` 都留在 Host 边界；Renderer 只得到固定来源类别及 manifest 身份信息。面板运行在独立、非持久 partition 的 Main-owned `WebContentsView`，Node/Electron/Pi 均不可见，只得到带 generation 的四方法 `window.piPlugin` context/state bridge；网络、权限、导航、popup 和下载默认拒绝。设置里的 Desktop 开关只控制右栏 contribution，不卸载或停用 Pi resource。

manifest 的 `permissions` 当前只用于清单展示，并不授予文件、shell、browser 或 network capability；第三方 command、native surface/backend 和 MCP Apps 尚未开放。Pi extension 仍是 Agent Host 中的可信本机用户代码，不是 sandbox。

### Skills

设置弹窗按基础设置（常规、外观、账号与模型）和 Agent 能力（技能、MCP、Desktop 插件）分组。桌面偏好用独立 typed Main IPC 严格白名单写入既有 electron-store 的 desktopSettings 键，不写 Pi CLI settings。提供深色/浅色/跟随系统、正文/代码字号、代码默认换行、减少动效、发送快捷键、工作过程默认开合与用量显示。保存确认后应用，失败保留旧值并显式只读重查；恢复默认只处理该键。主题由 Main 的 nativeTheme 与 Renderer 的系统色彩查询协调，不修改系统外观；终端原地更新 palette，网页与第三方内容不强制反色。初始读取未确认时键盘不发送；单块代码/工作过程手动覆盖优先，待处理审批强制可见，错误默认展开但允许手动收起，系统减少动效仍生效。

技能目录归当前 Pi session.resourceLoader 所有。Desktop 只展示已加载 metadata，按范围/名称/简介筛选；Host 用 opaque ID allowlist 提供有界普通 UTF-8 预览（64 KiB），检查文件指纹与会话代际，不接受 Renderer 路径。手动调用与模型可发现明确区分，不把 disableModelInvocation 当作关闭技能。

输入 `/` 唤起键盘可用的技能菜单，不占用常驻 toolbar 位置；选择替换查询前缀为原生 `/skill:name `，Enter 只插入，Esc 关闭，Shift+Enter/IME 不误发。设置插入保留完整当前草稿。插入意图绑定 project/session/generation，一次消费，不覆盖异步期间的新编辑。命令展开继续由 Pi 执行；原附件路径禁用展开，因此首版显式阻止组合发送。刷新仅读取现有 catalog，新技能通过原有项目生命周期加载，不调用全资源 reload。安装/编辑/删除/通用启停和技能市场未实现。

## 5. 账号

设置改为 App 级 Radix Dialog，左下角打开，分为账号与模型、MCP 服务器、Desktop 插件；不再占据右侧工作台。打开时保持布局/草稿，暂停原生面板可见性，关闭恢复原面板与入口焦点。Codex 按主账号/别名独立显式刷新订阅额度；Host 从公开 ModelRuntime 解析所选 OAuth 身份，固定 Codex 账号服务地址，只返回白名单额度。登录代际更新清空旧结果；接口未知/失败不能呈现为零额度。

MCP 是 Pi inline extension + 官方稳定 MCP SDK 的窄工具桥，不是自造协议，也不宣称 Pi 内置支持。单一 `mcp` 代理提供 list/describe/call；配置热应用只重连桥内 clients，保持 canonical AgentSession。用户全局 `mcp.json` 保存标准 `mcpServers` 和 Desktop 精确配置确认摘要，不扫描项目。stdio/Streamable HTTP 文本工具先行，Ask 所有调用确认，Open 直通；启用确认解释启动代码风险。远程 OAuth、resources/prompts、Apps、JSON 导入延期。取消、session_shutdown 和应用退出关闭 clients，不保证回收恶意 detached daemon。配置写入具 revision 复核与原子替换，但不提供针对其他本机进程的跨进程事务锁或 OS sandbox。

凭证只在 `~/.pi/agent/auth.json`。一 provider 一槽；多号用别名（`anthropic-work`、`openai-codex-home`），兼容 `@hank-warren/pi-multi-login`。

**Codex（ChatGPT Plus/Pro）— 直登必须有，导入只是顺手**

- 主路：设置「登录 Codex」→ Pi `/login` → `openai-codex`（Codex for OSS）。OAuth 当前仍使用系统浏览器；loopback 失败走 device code。不会让 agent 借右栏 Browser 读取 provider 凭证。
- 多号：别名槽 `openai-codex-<slug>`，不覆盖主机 `~/.codex`。
- 延期：检测并导入 `~/.codex/auth.json` 只是便利能力，本轮未实现；没装 CLI 的人已经可以通过 Pi `/login` 直登。

**Anthropic**：Pi `/login anthropic` 的用量口径由该连接方式决定，不应显示成其他客户端的订阅额度，也不默认导入其他客户端凭证。

**自定义端点**：独立设置组件提供 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，不把两种 OpenAI 协议混用。全局 Pi 配置影响所有项目及 CLI，新增端点不自动选中。使用 jsonc-parser 局部编辑 canonical models.json，凭证只调用公开 ModelRuntime login；高级配置保守只读，损坏/过期文件不覆盖。只返回白名单元数据，密码本地组件态、从不回填，提交/关闭清空；编辑留空保留现有 key。CLI `models.json` 里已有、且运行时已具备可用模型的 provider（含非 `custom-*`、带嵌入 `apiKey` 的只读项）会出现在 composer 账号菜单中供显式选择；没有可用认证的端点仍不能发送。

表单分别展示 metadata/credential/runtime 确定结果和部分成功；传输失败提示结果未知、禁止自动重试。刷新列表只读，不伪称修复运行时。保存与登录启动/别名重载在同一 actor 排队，执行时再次检查 OAuth、会话代际和忙碌。运行时同步失败与模型选择失效用两个独立门禁同时约束 Host/composer；普通保存成功不能清掉待显式选择的失效状态。原会话记录保留，同 ID 重新绑定仍使用 canonical model_change 和 mutation guard。

Composer 两级：账号 → 模型。浏览账号不创建会话；已有 transcript 时切换模型调用 Pi `AgentSession.setModel()`，在同一 JSONL 追加 canonical `model_change` 并保留上下文。新会话跟随当前 active 账号与模型；模型不可用时保持只读，不做静默 failover。Pi SDK `0.84.4` 的公开 `ModelRuntime.login()` 在返回前已同步该进程中的凭证、catalog 与 availability 投影；登录后重新读取公开投影，不直接操作私有 `authStorage.reload()`。升级 SDK 时重新核验这一约束。

## 6. 手机端与外网

桌面 = runtime，手机 = 同一 session 的 PWA 对话面。MVP：会话列表、接着聊、Stop/Queue/Steer（运行中发送进入 follow-up 队列）、Ask 批准、跑完 SSE `run-finished`（作为后续推送钩子）。Files/Git/终端/浏览器不上手机。手机 PWA 用同一套页面适配窄屏（列表 → 会话栈）与宽屏（左侧项目/会话 + 主对话），不把 Files/Git/终端/浏览器或 Review 工作台放到远程对话面上。

可达性：1) 网关始终绑定 **127.0.0.1**；显示局域网二维码时额外绑定当前 RFC1918 Wi‑Fi 地址（不是 0.0.0.0，也不做端口转发）2) **主路远程：Tailscale Serve**（`tailscale serve --bg http://127.0.0.1:<port>` → `https://*.ts.net`，仅尾网，不是 Funnel）3) Cloudflare Quick Tunnel 为可选备用（无账号、URL 每次变）。一次性配对 + 按设备 grant，桌面可撤。开网关时请求防休眠，并提示保持 Mac 唤醒。文案：「手机能用这台电脑上的工具改文件、跑命令。只扫你自己的码。」

## 7. 进程与数据

多会话：Main 管理最多 8 个独立会话 utilityProcess，另有不持有会话 writer 的启动/设置 Host。切换只改变前台投影，后台 Pi 继续执行；同一 canonical JSONL 最多一个常驻 writer。桌面 `workerId + selectionEpoch` 与 Pi 原生 `sessionId + generation + revision` 分开，旧视图响应不能覆盖新视图。侧栏接收有界运行元数据，不保存第二份历史。

Stop、队列和审批绑定发起会话。运行中允许切换；编辑和登录仍有保护。空闲、已保存、无未确认结果的 worker 才能回收。Browser 本轮只允许前台 agent 控制，切换取消原会话的浏览器操作，不中止其他工作。全局账号/端点/MCP 修改要求所有会话空闲且结果已确认，并在下次 prompt 前刷新配置。

同项目内置 write/edit/bash 与 MCP 调用使用 Main 的互斥操作锁，Ask 先审批再排队，Open 也需排队；读文件和模型生成不排队。MCP 发送后超时/取消不等于执行结束，未知结果保持锁到该 worker 退出。这不是 OS 沙箱，不能约束外部进程、任意 Pi 扩展或退出后仍工作的远程 MCP/后台子进程。

Renderer (React) — 零 Node、零 Electron、零 Pi import。typed IPC。Main：窗口、最近项目偏好、WorkbenchHost、BrowserManager 和 `utilityProcess` 生命周期；Agent Host：`utilityProcess` 中的 Pi runtime、browser capability client 与已加载 Pi package root 发布。对话是按 `cwd` 分桶的 Pi JSONL 投影，Electron 不保存 transcript 副本或 token。`electron-store` 保存最近项目路径、Desktop 插件启用状态和每项不超过 32 KiB 的 panel JSON state；Browser profile 由 Electron partition 按 project 隔离。这些本地数据不含 Pi token/transcript，但路径、插件自存内容和网站登录态仍应按本地隐私数据对待。

流式同步先发送带 `sessionId + generation + revision` 的完整 snapshot，之后发送带 `baseRevision + revision` 的节点 upsert / removal / order patch 和轻量元数据。token 更新按短窗口合并，completed / settled 强制刷新；Renderer 对旧 patch 幂等忽略，对会话代际不匹配、乱序或 revision 缺口重新拉 snapshot。完整 snapshot 用于 bootstrap、项目/会话切换与恢复同步，不在每个 token 上重复传整份 transcript。

可见历史从 Pi `getBranch()` 投影，canonical entry ID 决定节点身份，不从压缩后的模型上下文或时间戳重建。流式临时节点按运行期出现次序追踪，在公开 core 的成功 append 边界一次性替换为 canonical 节点。不同模型的 extension 切换通过公开模型事件观察；重复同模型且没有公开事件的追加记录等待下次正常刷新。模型写入后发生失败或显示投影失败时隔离 Host，保留最后画布与草稿，显式重连读取实际文件；不宣称 SDK 所有写入都有事务回滚，也不将 append 成功等同 fsync。Electron 不保存第二份 transcript 或 token。

展开的 Think/工具详情在流式节点正式入历史及同代际刷新时保持展开。Host 仅保留有界的运行期 `presentationIdentity` 显示别名，React 使用该键保持组件状态；导航、审批与命令仍使用 canonical ID。显示别名不写入 JSONL，离开分支或重新绑定会话时清理，重新打开会话允许重置折叠状态。

## 8. 明确不做什么

不加载第三方 Web UI，不自造 OAuth，不把 Codex 做成只能导入 CLI，不把 Agent 端口转到公网；手机 MVP 不做工作台，也不做多账号自动 failover。Workbench 当前不做 marketplace、签名/自动更新、远端 entry、第三方 native/module/backend、通用 agent command binding 或 MCP Apps，也不把 Pi extension 宣传成 sandboxed code。

## 9. 建议落地顺序

1. 壳：三栏 + Hero + 工作区会话树（MVP 已覆盖）
2. 对话节点流 + composer + metrics（MVP 已覆盖 snapshot + revision patch、状态、Context 与 Queue；`@` / 图片附件和可拖内容轴延期）
   - **2b.** 账号：Codex 直登 + composer 两级切换（已覆盖显式选择、session pinning、Settings `custom-*` 端点，以及 CLI `models.json` 中运行时可用的只读 provider；`~/.codex/auth.json` 便利导入延期）
   - **2c.** 手机：gateway + 配对 + LAN QR + Tailscale Serve（Quick Tunnel 可选）
3. Browser + agent 共享控制（已覆盖首个真实 Workbench mode、隔离 profile、typed capability 与 E2E）
   - **3b.** Workbench contribution registry + 本地 sandboxed web plugin（MVP 已覆盖严格发现、启停/重载、context/state generation、崩溃隔离与真实 Electron E2E；分发、第三方 command/backend 和 MCP Apps 延期）
4. Files 编辑能力 + Review（Files 已有只读浏览；Review 已有只读未暂存/已暂存/分支差异，写入与 Last turn 延期）
5. 用户 PTY（三依赖初版已实现；无损 reload/TUI 恢复与原生安装包验收仍待完成）
6. Trace 等（尚未注册）
