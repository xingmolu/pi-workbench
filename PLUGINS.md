# Pi Desktop 插件体系与 Agent 运行时设计

状态：v1。第一阶段（插件运行时骨架）已实现，见第 13 节；其余阶段按第 10 节推进。本文定义插件体系第一阶段的边界、manifest、进程与权限模型、公开 API，以及与之配套的 Agent 运行时（runtime provider）契约。实现按第 10 节分阶段推进，每阶段有独立验收标准。

## 1. 目标与非目标

**目标**

- 用户和第三方可以在不修改 Pi Desktop 的前提下扩展：右侧视图、命令、Skill、MCP 服务器、Agent 工具。
- 内置功能与第三方插件走**同一套公开 API**，不存在私有通道。内置插件是公开 API 的第一个使用者，API 不够用会先在自家功能上暴露。
- 插件与底层 Agent 解耦：界面、命令、宿主 API 与具体 Agent 无关；与 Agent 相关的部分通过中立契约交付，将来接入 Codex、Claude Code 等运行时时插件无需重写。

**非目标（第一阶段不做）**

- 插件市场、`.piplug` 分发包、签名与自动更新。
- 常驻服务、插件间消息总线、主题、悬浮窗。
- 操作系统级沙箱。插件主进程是 Node 环境，权限网关只约束 `pi.*` API，不约束插件自己 `require('node:fs')`。本地插件按"用户信任其来源"对待，界面上明确说明。
- 第二个 Agent 运行时的实际接入（只完成契约与假运行时测试，见第 8 节）。

## 2. 分层

| 层 | 内容 | 与 Agent 的关系 |
|---|---|---|
| 宿主层 | 视图、命令、宿主 API（文件、git、通知、存储）、权限网关、审计 | 与 Agent 无关 |
| 中立 Agent 层 | Skill（SKILL.md）、MCP 服务器、Agent 工具（JSON Schema 声明） | 由宿主按当前运行时的原生方式交付 |
| 运行时专属层 | pi extension 等直接依赖某个运行时的扩展 | 必须在 manifest 中声明 `runtime`，不匹配时不加载并说明原因 |

审批、权限规则、撤销检查点属于宿主层，由第 8 节的"工具闸门"统一执行，不随运行时变化。

## 3. Manifest（schemaVersion 1，zod 校验）

manifest、RPC 消息和每个 `pi.*` 方法的参数都在 `src/shared/` 中以 zod schema 定义，Main 与插件进程共用。zod v4 的 `z.toJSONSchema` 用于导出给插件作者的 JSON Schema 和编辑器补全。

```json
{
  "schemaVersion": 1,
  "id": "works.example.git",
  "name": "Git",
  "version": "0.1.0",
  "description": "暂存、提交与推送",
  "main": "main.js",
  "engines": { "piDesktop": ">=0.2.0" },
  "permissions": ["ui.view", "git.read", "git.write"],
  "fs": { "read": ["project"], "write": [] },
  "net": { "domains": [] },
  "contributes": {
    "views": [
      { "id": "changes", "title": { "en": "Changes", "zh-CN": "改动" }, "icon": "diff", "entry": "views/changes.html", "order": 20 }
    ],
    "commands": [
      { "id": "git.commit", "title": { "en": "Commit", "zh-CN": "提交" }, "keywords": ["git"] }
    ],
    "skills": [{ "path": "skills/commit-message" }],
    "mcpServers": [],
    "agentTools": [
      {
        "name": "git_status",
        "description": "Summarize the working tree.",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        "risk": "read"
      }
    ]
  },
  "activation": ["onProject"]
}
```

规则：

- 必填 `schemaVersion`、`id`（小写、带命名空间）、`name`、`version`、`engines.piDesktop`。提供 `commands` 或 `agentTools` 时必须有 `main`。
- 所有路径相对插件根目录，解析符号链接后必须仍在根目录内。
- **迁移**：现有 `contributes.workbench[].surface.kind = "sandboxed-web"` 继续接受，内部转换为 `contributes.views`，并提示改用新字段。一个大版本后移除。
- `icon` 为宿主固定图标集中的 token，插件不能提供自己的 SVG（图标画在宿主 chrome 里）。
- `agentTools[].risk` 取 `read | write | external`，决定默认审批策略（第 7 节）。插件自报的风险只能**提高**审批要求，不能降低：宿主对 `write`、`external` 始终按至少同级处理。

## 4. 进程模型

```
Renderer（零 Node）
   │  typed IPC
Main ── PluginBroker ── 权限网关 ── 宿主服务（fs / git / ui / storage / 审计）
   │        ▲ RPC（zod 校验）
   │   Plugin Host（utilityProcess，每个插件一个）── main.js
   │
   └── 视图：WebContentsView（sandbox、contextIsolation、无 Node、按插件隔离的 partition）
             └── window.piPlugin 桥 → Main（同一权限网关）
```

- 插件主程序在独立的 `utilityProcess` 中运行，只拿到最小环境变量（`PATH`、`HOME`、`PI_PLUGIN_ID` 等），不继承模型密钥和宿主其余环境。
- 所有 `pi.*` 调用经过：API 白名单 → manifest 声明 → 用户授权 → 参数 zod 校验 → 宿主服务 → 审计日志。
- 贡献点只注册描述符；可调用的部分留在插件进程，宿主通过 RPC 回调，并设超时：加载 15s、命令 30s、Agent 工具 110s、卸载 5s。
- 插件进程崩溃时：挂起的调用以 `PLUGIN_CRASHED` 失败，撤销该插件的贡献，关闭其视图，给出提示；不影响主界面和 Agent 会话。
- 视图沿用现有 `sandboxed-web` 实现（独立 `WebContentsView`、收窄的桥、按项目的状态、崩溃隔离）。

## 5. 权限

权限在 manifest 中声明，启用插件时向用户逐项展示并授予；未声明或未授予的调用返回 `PERMISSION_DENIED`。开发中的插件新增权限时，热重载中止并要求重新授权。

| 风险 | 权限 |
|---|---|
| 低 | `ui.view`、`ui.command`、`notify`、`storage` |
| 中 | `fs.read`（限定在 `manifest.fs.read` 范围）、`git.read`、`clipboard.write`、`shell.openExternal` |
| 高 | `fs.write`、`git.write`、`agent.tools`、`agent.skills`、`mcp.local`、`mcp.remote`、`net.fetch`（限定在 `manifest.net.domains`） |

- `fs` 与 `net` 范围默认拒绝：未声明即无访问。`project` 表示当前项目根目录，按解析符号链接后的真实路径判断。
- 插件发起的写操作（`fs.write`、`git.write`）与 Agent 的写操作适用同一套项目档位（请求批准 / 帮我批准 / 完全访问）与自定义规则；`git.push` 这类对外操作在任何档位都需要用户确认。
- 审计日志记录插件 id、方法、目标路径与结果，不记录文件内容。

## 6. 扩展点（第一阶段）

| 扩展点 | 说明 |
|---|---|
| `views` | 右侧工作区视图。与现有 registry 合并：内置工具与插件视图在同一菜单中排序。 |
| `commands` | 出现在全局搜索（⌘K）中，由插件进程执行。 |
| `skills` | SKILL.md 目录。启用插件后对该项目的 Agent 可用；运行时无关。 |
| `mcpServers` | 本地 stdio 或远程 HTTP MCP 服务器，复用现有 MCP 配置与确认流程。 |
| `agentTools` | 以 JSON Schema 声明的 Agent 工具，由宿主按运行时交付（第 8 节）。 |

## 7. 公开 API v1

插件主进程注入全局 `pi`；视图中通过 `window.piPlugin` 调用其中标注"视图可用"的子集。

| 命名空间 | 方法 | 权限 |
|---|---|---|
| `pi.commands` | `register`、`unregister` | `ui.command` |
| `pi.ui` | `showToast`、`openView`、`setBadge` | `ui.view` / `notify` |
| `pi.storage` | 按插件、按项目的 JSON 存储（单项 ≤ 32 KiB，沿用现有限制） | `storage` |
| `pi.project` | `current()`、`onDidChange` | 无 |
| `pi.fs` | `readText`、`list`、`stat`；`writeText`（经工具闸门，可撤销） | `fs.read` / `fs.write` |
| `pi.git` | `status`、`diff`、`log`；`stage`、`unstage`、`discard`（可撤销）、`commit`、`push`（始终确认） | `git.read` / `git.write` |
| `pi.agent` | `registerTool`（与 manifest 声明对应）、`onTurnEnd`（只读：本轮改动摘要） | `agent.tools` |

约定：

- 所有方法返回 `Promise`，错误带稳定的 `code`（`PERMISSION_DENIED`、`INVALID_ARGUMENT`、`NOT_FOUND`、`CONFLICT`、`TIMEOUT`、`PLUGIN_CRASHED`、`UNSUPPORTED`）。
- `pi.git` 在 Main 中实现为独立的 git 能力服务，内置 Git 插件与第三方插件共用。现有 Review 面板的只读 diff 逻辑（`src/main/git-review.ts`）迁入该服务。

## 8. Agent 运行时（runtime provider）

### 8.1 现状

`src/main/agent-runtime.ts` 已有会话级抽象：`AgentRuntime.createSession()` 返回 `AgentRuntimeSession`，通过 `HostCommand` / `HostEvent` 与 Main 通信，另有 `onCapability` 通道承载 SessionTask 与 Computer Use。问题是这组契约实际上是按 pi 设计的：

- 审批、权限规则、撤销检查点都写在 pi 专属的 Agent Host 里，挂在 pi 的 `tool_call` 钩子上；
- `ConversationNode` 投影、会话列表、模型与账号都直接取自 pi 的 SDK；
- 插件的 Agent 工具目前没有交付路径。

### 8.2 目标契约

运行时适配器只负责"把某个 Agent 的原生协议翻译成宿主契约"，宿主策略全部留在宿主。适配器需要实现：

```ts
interface AgentRuntimeAdapter {
  descriptor: AgentRuntimeProviderDescriptor & {
    toolDelivery: 'native' | 'mcp'          // 插件工具如何交给这个 Agent
    skills: 'native' | 'prompt' | 'none'     // Skill 如何交付
  }
  createSession(options): Promise<AgentRuntimeSession>
}

// 每个工具调用在执行前后都必须经过宿主的工具闸门
interface ToolGate {
  before(call: { sessionId; turnId; toolCallId; tool; input; cwd }): Promise<
    { decision: 'allow' } | { decision: 'deny'; reason: string }
  >
  after(call: { sessionId; toolCallId; ok: boolean; result?: unknown }): void
}
```

- `ToolGate.before` 统一执行：档位与自定义规则判断 → 需要时发起审批 → 获取项目写锁 → 写操作前保存检查点。`after` 记录写后哈希并释放写锁。这些逻辑已经存在（`permission-rules-store.ts`、`checkpoints.ts`、审批注册表），需要从 pi Agent Host 中抽成与运行时无关的模块，pi 适配器在 `tool_call` 钩子里调用它。
- 工具名在闸门内归一化为语义类别（`shell`、`file.write`、`file.edit`、`browser`、`computer`、`mcp`、`plugin`），各运行时的工具名映射由适配器提供，权限判断只看类别。
- 插件的 `agentTools`：`toolDelivery = native` 时直接注册（pi 的 `registerTool`）；`= mcp` 时由宿主为该会话启动一个本地 MCP 桥，把插件工具暴露给 Agent，调用仍经过 `ToolGate`。
- 会话事件归一化为现有 `ConversationNode`；运行时独有的节点类型通过扩展字段携带，渲染层对未知类型显示通用卡片。
- 评估 Zed 的 Agent Client Protocol（ACP）作为非 pi 运行时的首选接入方式：如果目标 Agent 已支持 ACP，适配器实现一次即可复用。

### 8.3 现在做到什么程度

- **做**：抽出 `ToolGate` 与工具类别映射；pi 适配器改为调用它；插件工具的 native 交付路径；用一个测试用的假运行时（fake runtime）验证 `ToolGate`、MCP 桥和事件归一化，证明契约不依赖 pi。
- **不做**：接入第二个真实运行时；会话存储抽象（仍用 pi JSONL）；模型与账号抽象。

## 9. 内置功能的归属

| 功能 | 归属 | 说明 |
|---|---|---|
| Files | 内置插件（随应用分发，可禁用、不可卸载） | 只用 `pi.fs` 公开 API，作为 API 的第一个验证者 |
| Git（暂存、提交、推送） | 新的内置插件 | 只用 `pi.git`；提交信息可调用当前模型起草 |
| 对话内改动、本轮汇总、撤销 | 宿主 | 属于对话证据，跟随消息存在，不做成插件 |
| Terminal、Browser | 暂留宿主 | 依赖原生 PTY 与 WebContentsView，等公开 API 能覆盖后再评估 |
| 权限档位与审批 | 宿主 | 属于工具闸门 |

## 10. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 运行时骨架 | manifest v1（zod）、插件进程与 RPC、权限网关与授权界面、审计、崩溃隔离、`commands` / `views` 合并 | 示例插件能注册命令和视图；未授权调用被拒；插件崩溃不影响会话（Electron E2E） |
| P2 宿主 API | `pi.fs`、`pi.git`、`pi.storage`、`pi.ui`；Files 改为内置插件 | 现有 Files E2E 全部通过且无私有通道 |
| P3 Git 插件 | 暂存、丢弃（可撤销）、提交、推送（确认） | 从改动到推送的完整 E2E；推送在"完全访问"下仍确认 |
| P4 Agent 扩展 | `ToolGate` 抽取、`agentTools`（native）、`skills`、`mcpServers`、假运行时测试 | 插件工具在三个档位下行为正确；假运行时经 MCP 桥调用插件工具 |


- 对齐：manifest 核心字段、`contributes.views/commands/agentTools/skills/mcpServers`、权限名称、`pi.*` 中已实现方法的参数形状、错误码。
- 不对齐：分发格式与市场、常驻服务与消息总线、主题、pi 会话与 LLM 上下文类 API（第一阶段）。
- 许可：对方为 LGPL-3.0。我们只参考接口约定与设计，不复制其代码。

## 12. 待定问题

2. 插件目录：沿用现有 `~/.pi/agent/desktop-plugins/<id>/`，还是改为 Pi Desktop 自己的数据目录？
3. 内置 Git 插件的提交信息起草：直接调用当前会话模型，还是提供独立的一次性补全 API（`pi.agent.complete`）？
4. 审计日志的保留期与查看入口。

## 13. 第一阶段实现说明

已实现：

- 授权：含 `main` 或申请 `ui.view` 以外已知权限的插件默认关闭；在设置 → Desktop 插件中打开开关时先展示所请求的权限及风险，确认即授予。之后 manifest 申请了新权限，插件自动暂停，需重新授权。关闭即撤销授权。仅含视图的插件保持原有的默认启用行为。未知权限名照常显示，标注"此版本不支持，不会授予"。
- 进程：每个启用的插件一个 `utilityProcess`（`out/main/plugin-host.js`），只继承 `PATH`、`HOME`、`USER`、`LANG`、临时目录与 `PI_PLUGIN_ID`。
- 网关与 API：`pi.commands.register/unregister`（只能注册 manifest 中声明的命令）、`pi.ui.showToast`（`notify`）、`pi.ui.openView`（`ui.view`，只能打开自己声明的视图）、`pi.storage.get/set`（`storage`，按插件与项目隔离，单值 ≤ 32 KiB）、`pi.project.current`。每次调用写入 `~/.pi/agent/pi-desktop/plugin-audit.jsonl`（方法与结果，不含参数，1 MiB 轮转一次）。
- 命令出现在 ⌘K 的"插件命令"分组中；执行超时 30 秒，加载超时 15 秒。
- 崩溃隔离：插件进程退出时，挂起的命令以 `PLUGIN_CRASHED` 失败，命令从 ⌘K 移除，界面提示，不自动重启；在设置中关开一次即可重新启动。

最小示例：

```json
{
  "schemaVersion": 1,
  "id": "acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "engines": { "piDesktop": "^0.1.0" },
  "main": "main.js",
  "permissions": ["ui.view", "notify"],
  "contributes": {
    "views": [{ "id": "panel", "title": "Hello", "icon": "flask", "entry": "views/panel.html" }],
    "commands": [{ "id": "greet", "title": "Say hello" }]
  }
}
```

```js
module.exports = {
  async onLoad() {
    await pi.commands.register({
      id: 'greet',
      run: async () => {
        await pi.ui.showToast('Hello')
        await pi.ui.openView('panel')
      }
    })
  }
}
```

放到 `~/.pi/agent/desktop-plugins/hello/` 下，在设置 → Desktop 插件中重新加载并授权即可。
