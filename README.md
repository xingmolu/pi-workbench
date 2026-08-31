# Pi Desktop

Electron 桌面壳：三栏布局学 DSH 对话密度 + Codex 右侧工作台。引擎将是 `@earendil-works/pi-coding-agent`，跑在 Node `utilityProcess` 里。会话目录：`~/.pi/agent/`。

本仓库是可编译的骨架，尚未接入对话引擎、登录或手机网关。不 fork dsh-desktop，不加载 DSH Web UI。产品说明见 [DESIGN.md](./DESIGN.md)。

## 本地运行

```bash
npm install
npm run dev
```

类型检查与生产构建：

```bash
npm run typecheck
npm run build
```

仅预览渲染进程（不拉起 Electron 窗口）：

```bash
npx electron-vite dev --rendererOnly
```

开发时渲染进程默认 `http://127.0.0.1:43123`。

## 架构

| 进程 | 职责 |
| --- | --- |
| **Main** | 窗口、托盘、以后的 WebContentsView / 用户 PTY。派生 Agent Host。 |
| **Agent Host** | `utilityProcess`。以后在此 `createAgentSession({ agentDir: ~/.pi/agent })`，不要从 Renderer 引用 Pi SDK。 |
| **Renderer** | React UI。零 Node、零 Pi import，只走 typed IPC。 |

会话与凭证落在 `~/.pi/agent/`（含 `auth.json` / JSONL 会话）。Renderer 只投影这些数据。
