# Pi Desktop

Pi Desktop 是一个本地 Electron + React 客户端，直接嵌入
`@earendil-works/pi-coding-agent`。它不加载 DSH Web UI，也不复制 Pi 的会话或凭证。

当前 MVP 聚焦 [DESIGN.md](./DESIGN.md) §9 的步骤 1、2 和 2b：

- 文档流对话节点：user、assistant Markdown、think、tool；
- composer：Open / Ask、账号 → 模型、ContextMeter、Send / Stop / Queue；
- 会话标题、运行/待确认/错误状态、固定 provider/model，以及完整 follow-up 队列；
- 真实 Pi usage、context 和本次运行期时序指标，不估算费用；
- Codex（ChatGPT Plus / Pro）浏览器登录与 device code；
- Pi 多账号 provider 别名 `openai-codex-<slug>`；
- 按 `cwd` 分桶的 Pi JSONL 会话列表、新建与恢复；
- 默认 52px 的 Workbench mode rail，以及按需展开的账号与模型设置。

Files、Git Review、用户 PTY、Browser、Trace、手机网关和 worktree / 并行 agent
仍是后续边界；当前右侧相应 mode 只是占位，不代表功能已经实现。`@` 文件/会话引用、
图片粘贴附件、用户可拖内容轴、`~/.codex/auth.json` 便利导入，以及自定义兼容端点的
管理 UI 也明确延期。

技术选型与取舍见 [docs/TECH_STACK_RESEARCH.md](./docs/TECH_STACK_RESEARCH.md)，本轮竞品调研与落地映射见
[docs/COMPETITIVE_RESEARCH.md](./docs/COMPETITIVE_RESEARCH.md)。

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

E2E 会把空态、设置和项目门禁截图写入 `artifacts/e2e/`；该目录已加入
`.gitignore`，只作为本地验证产物。

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
   的会话固定自己的 provider/model，选择另一模型时会明确新建会话。
5. Ask 是本次应用运行期的审批策略，会在 bash、powershell、write、edit 前显示确认；
   Open 允许 Pi 在本次运行中直接调用工具。重启后恢复为 Ask；它们不是 OS sandbox
   或持久 allow/deny 规则。
6. agent 运行中发送的新输入进入 Pi follow-up 队列；界面显示完整待发送文本，并支持清空全部队列。单项编辑、删除和 steer 尚未实现。

## 数据与隐私边界

生产运行的 Pi `agentDir` 固定为 `~/.pi/agent`：

- 凭证与自定义模型：`~/.pi/agent/auth.json`、`~/.pi/agent/models.json`
- 会话：`~/.pi/agent/sessions/` 下按 `cwd` 分桶的 JSONL
- 多账号配置：`~/.pi/agent/pi-multi-login.json`

应用不会把 token 放进 Electron `safeStorage`，也不会保存第二份 transcript。Main
使用 `electron-store` 仅保存最近一次成功打开且已规范化的项目路径，启动时会重新校验，
失效后清除。这是本地偏好数据，不含 token 或 transcript；但路径本身可能暴露用户名、
客户名或项目名，应按本地隐私数据对待。测试专用 agentDir 覆盖只允许在未打包的显式
E2E 模式中使用，生产构建会拒绝该模式并忽略其他路径覆盖值。

## 架构

| 进程       | 职责                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Main       | 窗口、文件夹选择、最近项目偏好、OAuth 外链 allowlist、Zod IPC broker、`utilityProcess` 生命周期 |
| Agent Host | Pi `AgentSessionRuntime` / `ModelRuntime` / `SessionManager`、登录、流式投影、权限 hook         |
| Preload    | 只暴露窄的 `window.pi` 请求与事件 API                                                           |
| Renderer   | React 文档流、Radix 交互原语、Zustand 内存状态；零 Node、零 Pi import                           |

Host 在初始化、项目/会话切换和重新同步时发送完整 snapshot；随后发送带
`sessionId + generation + baseRevision + revision` 的节点 patch。Renderer 只按连续 revision
合并，遇到会话代际不匹配或 revision 缺口时重新请求 snapshot。

关键入口：

- `src/agent-host/index.ts`：Pi runtime、登录、会话、权限与节点投影
- `src/shared/contracts.ts`：跨进程 DTO 与 snapshot / patch 协议
- `src/main/index.ts`：`utilityProcess` broker、最近项目与 Electron 安全边界
- `src/renderer/src/components/Conversation.tsx`：对话、状态、Context、Queue 与 composer
- `src/renderer/src/components/Workbench.tsx`：账号设置与右栏占位
