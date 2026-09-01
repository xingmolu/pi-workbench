# Pi Desktop

Pi Desktop 是一个本地 Electron + React 客户端，直接嵌入
`@earendil-works/pi-coding-agent`。它不加载 DSH Web UI，也不复制 Pi 的会话或凭证。

当前实现对应 [DESIGN.md](./DESIGN.md) §9 的步骤 2 / 2b：

- 文档流对话节点：user、assistant Markdown、think、tool；
- composer：Open / Ask、账号 → 模型、ContextMeter、Send / Stop / Queue；
- 真实 Pi usage、context 和本次运行时序指标，不估算费用；
- Codex（ChatGPT Plus / Pro）浏览器登录与 device code；
- Pi 多账号 provider 别名 `openai-codex-<slug>`；
- 按 cwd 分桶的 Pi JSONL 会话列表、新建与恢复；
- Files、Git Review、用户 PTY、Browser 仅保留右栏占位。

技术选型与取舍见 [docs/TECH_STACK_RESEARCH.md](./docs/TECH_STACK_RESEARCH.md)。

## 本地运行

```bash
npm install
npm run typecheck
npm run dev
```

生产构建与本地安装目录打包：

```bash
npm run build
npx electron-builder --dir
```

开发时 Renderer 默认运行在 `http://127.0.0.1:43123`。

## 使用

1. 左侧“打开文件夹”选择项目；该路径就是 Pi 的 `cwd`。
2. 打开“设置 → 账号与模型”，点击“浏览器登录”。这会调用 Pi 的
   `ModelRuntime.login('openai-codex', 'oauth', …)`，等价于 Pi `/login openai-codex`。
3. 若本机 loopback 端口不可用，Host 自动选择 device code；也可以直接点击“设备码”。
4. 登录后在 composer 先选账号、再选模型。新会话继承当前选择；已经有消息的会话保持自己的 provider/model，切换时会新建会话。
5. Ask 模式会在 bash、write、edit 前显示确认卡片；Open 模式直接执行。

Pi 的数据位置保持不变：

- 凭证与自定义模型：`~/.pi/agent/auth.json`、`~/.pi/agent/models.json`
- 会话：`~/.pi/agent/sessions/` 下按 cwd 分桶的 JSONL
- 多账号配置：`~/.pi/agent/pi-multi-login.json`

应用不会把 token 放进 Electron `safeStorage`，也不会保存第二份 transcript。

## 架构

| 进程       | 职责                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| Main       | 窗口、文件夹选择、OAuth 外链 allowlist、Zod IPC broker、`utilityProcess` 生命周期       |
| Agent Host | Pi `AgentSessionRuntime` / `ModelRuntime` / `SessionManager`、登录、流式投影、权限 hook |
| Preload    | 只暴露窄的 `window.pi` 请求与事件 API                                                   |
| Renderer   | React 文档流、Radix 交互原语、Zustand 内存状态；零 Node、零 Pi import                   |

关键入口：

- `src/agent-host/index.ts`：Pi runtime、登录、会话、权限与节点投影
- `src/shared/contracts.ts`：跨进程 DTO
- `src/main/index.ts`：utilityProcess broker 与 Electron 安全边界
- `src/renderer/src/components/Conversation.tsx`：对话与 composer
- `src/renderer/src/components/Workbench.tsx`：账号设置与右栏占位
