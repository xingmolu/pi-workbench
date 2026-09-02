# Pi Desktop

Pi Desktop 是一个本地 Electron + React 客户端，直接嵌入
`@earendil-works/pi-coding-agent`。它不加载 DSH Web UI，也不复制 Pi 的会话或凭证。

当前 MVP 覆盖 [DESIGN.md](./DESIGN.md) §9 的步骤 1、2、2b、3 和 3b：

- 文档流对话节点：user、assistant Markdown、think、tool；
- composer：Open / Ask、账号 → 模型、ContextMeter、Send / Stop / Queue；
- 会话标题、运行/待确认/错误状态、同会话模型切换，以及完整 follow-up 队列；
- 真实 Pi usage、context 和本次运行期时序指标，不估算费用；
- Codex（ChatGPT Plus / Pro）浏览器登录与 device code；
- Pi 多账号 provider 别名 `openai-codex-<slug>`；
- 按 `cwd` 分桶的 Pi JSONL 会话列表、新建与恢复；
- Main 发布的 typed Workbench registry、默认 52px mode rail，以及按需展开的账号、模型与
  Desktop 插件设置；
- Files、Review、Terminal 仍是已注册的 first-party 占位面板；Browser 是 Main 持有的原生
  `WebContentsView`，支持多标签页、按 project 隔离的持久 profile 和用户/agent 共享控制；
- 本地 `sandboxed-web` Workbench 插件：严格 manifest、独立 `WebContentsView`、窄化
  `window.piPlugin` bridge、按 project 状态和崩溃隔离；
- Pi `browser` 工具：snapshot/ref、click/fill/select、导航、wait、screenshot 与 Stop。

Files、Git Review、用户 PTY、Trace、手机网关和 worktree / 并行 agent 仍是后续边界；
前三项虽已进入 registry，当前面板仍只是占位，不代表相应产品功能已经实现。插件
marketplace、签名、自动更新、远端 UI 入口、第三方 native/module、通用 agent command
绑定和 MCP Apps 也明确延期。`@` 文件/会话引用、
图片粘贴附件、用户可拖内容轴、`~/.codex/auth.json` 便利导入，以及自定义兼容端点的
管理 UI 也明确延期。

技术选型与取舍见 [docs/TECH_STACK_RESEARCH.md](./docs/TECH_STACK_RESEARCH.md)，本轮竞品调研与落地映射见
[docs/COMPETITIVE_RESEARCH.md](./docs/COMPETITIVE_RESEARCH.md)，Workbench / Agent Browser
专项调研与实施结果见 [docs/WORKBENCH_AGENT_RESEARCH.md](./docs/WORKBENCH_AGENT_RESEARCH.md)。
已落地的插件边界、manifest 和 panel API 见
[docs/WORKBENCH_PLUGIN_ARCHITECTURE.md](./docs/WORKBENCH_PLUGIN_ARCHITECTURE.md)。

## 本地运行

安装依赖并启动开发环境：

```bash
npm install
npm run dev
```

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
