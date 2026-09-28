# Pi Desktop 插件体系与 Agent 运行时设计

状态：v1。第一至五阶段已实现，见第 13–17 节。第 3 节的 manifest 示例是早期草案，实际字段以第 16、17 节为准。本文定义插件体系第一阶段的边界、manifest、进程与权限模型、公开 API，以及与之配套的 Agent 运行时（runtime provider）契约。实现按第 10 节分阶段推进，每阶段有独立验收标准。

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
| 低 | `ui.view`、`ui.command`、`ui.theme`、`notify`、`storage` |
| 中 | `fs.read`（限定在 `manifest.fs.read` 范围）、`git.read`、`clipboard.write`、`shell.openExternal` |
| 高 | `fs.write`、`git.write`、`git.push`、`agent.tools`、`agent.skills`、`mcp.local`、`mcp.remote`、`net.fetch`（限定在 `manifest.net.domains`） |

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
| `pi.git` | `status`、`diff`、`log`；`stage`、`unstage`、`discard`（可撤销）、`commit`；`push`（始终确认） | `git.read` / `git.write` / `git.push` |
| `pi.agent` | `registerTool`（与 manifest 声明对应，已实现）、`onTurnEnd`（只读：本轮改动摘要，未实现） | `agent.tools` |

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
| Git（暂存、提交、推送） | 内置插件（`resources/plugins/git`，已完成） | 只用 `pi.git`；提交信息可调用当前模型起草 |
| 对话内改动、本轮汇总、撤销 | 宿主 | 属于对话证据，跟随消息存在，不做成插件 |
| Terminal | 内置插件（`resources/plugins/terminal`，已完成） | 以宿主视图 `host: "terminal"` 贡献面板；PTY 进程与终端界面仍由宿主实现，见 §19 |
| Browser | 内置插件（`resources/plugins/browser`，已完成） | 以宿主视图 `host: "browser"` 贡献面板；原生视图与 Agent 的 `browser` 工具仍由宿主实现，见 §19 |
| 权限档位与审批 | 宿主 | 属于工具闸门 |

## 10. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 运行时骨架 | manifest v1（zod）、插件进程与 RPC、权限网关与授权界面、审计、崩溃隔离、`commands` / `views` 合并 | 示例插件能注册命令和视图；未授权调用被拒；插件崩溃不影响会话（Electron E2E） |
| P2 宿主 API | `pi.fs`、`pi.git`、`pi.storage`、`pi.ui`；视图可直接调用；插件写操作审批（Files 迁移推后，见 §14） | 视图读取项目文件、写入前审批、暂存与提交的 Electron E2E |
| P3 Git 插件 | 随应用分发的内置插件机制；暂存、丢弃、提交、推送（确认） | 从改动到推送的完整 E2E；推送在"完全访问"下仍确认 |
| P4 Agent 扩展（已完成，见 §16） | `ToolGate` 抽取、`agentTools`（native）、`skills`、`mcpServers`、假运行时测试 | 插件工具在三个档位下行为正确；假运行时经 MCP 桥调用插件工具 |


- 对齐：manifest 核心字段、`contributes.views/commands/agentTools/skills/mcpServers/settings`、权限名称（通过别名映射）、`pi.*` 中已实现方法的参数形状、视图桥 `window.pluginBridge`、错误码。实现细节见 §17。
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
- 网关与 API：`pi.commands.register/unregister`（只能注册 manifest 中声明的命令）、`pi.ui.showToast`（`notify`）、`pi.ui.openView`（`ui.view`，只能打开自己声明的视图）、`pi.storage.get/set`（`storage`，按插件与项目隔离，单值 ≤ 32 KiB）、`pi.project.current`。调用写入 `~/.pi/agent/pi-desktop/plugin-audit.jsonl`（方法与结果，不含参数，1 MiB 轮转一次；第三阶段起成功的调用只记高风险方法，见 §15）。
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

## 14. 第二阶段实现说明

- `pi.fs`：`list`、`stat`、`readText`（≤ 1 MiB、UTF-8）、`writeText`（≤ 2 MiB 字符）。路径一律相对当前项目，参数层拒绝绝对路径、`..` 和反斜杠；Main 再按解析符号链接后的真实路径确认仍在项目内，写入前父目录创建后再校验一次。列目录跳过 `.git`，最多 2,000 项。
- `pi.git`：`status`、`diff`（可指定路径与已暂存）、`log`；`stage`、`unstage`、`discard`、`commit`。复用 Review 的加固执行器：不运行仓库 hooks、关闭 fsmonitor、忽略全局与系统配置、禁止终端提示；仓库配置了 clean/process 过滤器时拒绝操作，因为暂存和比较会执行它们。提交身份优先用仓库本地配置，否则只从用户全局配置读取 `user.name` 与 `user.email` 两项。
- 推送暂未提供：加固执行器不读取用户的凭据配置，推送需要单独的执行路径，放到第三阶段。
- 视图调用：面板页面通过 `window.piPlugin.call(method, params)` 调用同一套网关，与插件进程共享权限、参数校验和审计；视图不能注册命令。失败时以普通对象 `{ name, code, message }` 拒绝（`contextBridge` 会丢掉 Error 的自定义字段）。只有视图、没有 `main` 的插件同样可以申请 `fs.read`、`git.read` 等权限，启用前同样需要授权。
- 写操作审批沿用当前会话的项目档位：请求批准下每次写入、暂存、取消暂存、提交、丢弃都会弹出确认；帮我批准下只有丢弃需要确认；完全访问不再询问。确认框明确标出发起的插件，覆盖在原生插件视图之上（视图会暂时隐藏），2 分钟无响应视为拒绝。审批期间切换项目会取消该次写入。
- Files 迁移为插件推后：现有 Files 依赖"添加到对话"、⌘K 文件搜索等宿主能力，迁移不带来用户可见的变化；以 Git 插件作为公开接口的第一个真实使用者。

## 15. 第三阶段实现说明

- 随应用分发的内置插件：放在 `resources/plugins/<目录>/pi-desktop.json`，与用户插件用同一套 manifest、网关和视图宿主，没有私有通道。打包时 `resources/plugins/**` 解出 asar（`asarUnpack`），插件文件在磁盘上是普通文件；开发与 E2E 直接读仓库里的目录。
- 信任方式：内置插件默认启用，授予的就是 manifest 里请求的权限（安装应用即完成审阅），授权不写入存储；可以在设置中关闭，不能卸载；设置里显示"范围：内置 · 来源：随 Pi Desktop 分发"。
- 来源隔离：内置根目录只由 Main 产生，不经过 Agent Host 的包根合并，Agent Host 发来的根目录也不能声明 `bundled`（schema 仍只接受 `user` / `project`）。发现时内置根排在最前面，用户或项目插件使用相同 id 会被判为重复并忽略，不能冒充内置插件。
- `pi.git.push`（新权限 `git.push`，高风险）：
  - 先用加固执行器生成推送计划：当前分支、HEAD、远程与远程分支（没有上游时选 `origin` 或唯一的远程，并在推送后设为上游）、将要推送的提交（最多列 20 条）。远程地址里的用户名和密码会被去掉后再展示。
  - 确认框在任何档位（包括完全访问）都会弹出，列出远程、地址和提交。
  - 推送的是确认时的那个提交（`<hash>:refs/heads/<分支>`），确认后 HEAD 或分支变了就取消。
  - 推送使用用户自己的环境和全局配置，这样凭据助手、SSH agent、代理才能工作；但命令行上关闭仓库 hooks（包括 pre-push）和 fsmonitor，禁用 `ext::` 协议，关闭终端提示，并且不继承指向其他仓库或配置的 `GIT_*` 变量。
  - 仓库本地配置里如果有会执行程序或改写推送目标的设置（`core.sshCommand`、`credential.*`、`url.*`、`include*`、`remote.*.receivepack` 等），拒绝代为推送，提示在终端中推送。
  - 失败归类：被拒绝（需要先拉取）→ `CONFLICT`；凭据不可用 → `PERMISSION_DENIED` 并提示配置凭据助手或 SSH 密钥；超时 120 秒。
- `pi.git.status` 增加 `upstream`（如 `origin/main`，尚未推送时为 `null`）。
- 审计调整：拒绝和失败都记录；成功的调用只记录高风险方法（写入、暂存、提交、丢弃、推送等）。面板会定时读取状态，逐条记录读操作会淹没真正重要的写操作。
- Git 插件（`works.pi.git`）只有视图、没有 `main`，不会常驻进程。面板显示分支与领先/落后提交数、已暂存与未暂存改动（点开看差异）、逐个或全部暂存/取消暂存、丢弃、提交（没有暂存时"暂存全部并提交"，⌘/Ctrl+Enter）、推送和最近提交；在面板获得焦点、切回可见和每 4 秒刷新一次，列表内容没变时不重建，以免打断悬停和已展开的差异。
- 提交信息起草（§12 第 3 条）仍待定，留到提供一次性补全 API 时再做。

## 16. 第四阶段实现说明

- **ToolGate**（`src/agent-host/tool-gate.ts`）：与运行时无关的工具闸门。工具先归入语义类别（`read`、`shell`、`file.write`、`file.edit`、`browser`、`computer`、`mcp`、`plugin`、`task`），权限只看类别：
  - `shell` / `file.*`：完全访问直接放行；否则先看项目规则（"帮我批准"下包括安全命令和项目内编辑），不命中就确认。放行后取项目写锁，文件写入前保存检查点，结束后结算检查点、释放写锁。
  - `browser`（会改变页面的动作）：完全访问放行，其余确认。`computer`（act）：任何档位都确认。
  - `plugin`：请求批准下确认（声明 `readOnly` 的工具除外）；帮我批准和完全访问直接放行。插件工具内部再调用 `pi.fs` / `pi.git` 写入时，仍按插件 API 自己的审批规则确认。
  - `mcp`：服务器和工具要到调用时才知道，审批和写锁仍在 MCP 运行时内部完成，闸门直接放行。
  - pi 适配器只做两件事：`piToolCategory` 把 pi 的工具名映射到类别；`tool_call` 钩子调用 `ToolGate.before`，`tool_execution_end` 调用 `after`。
- **manifest 新增**：
  - `contributes.agentTools`：`{ name, title?, description, parameters(JSON Schema, object), readOnly? }`，需要 `main`，工具名在插件内唯一。
  - `contributes.skills`：插件目录内的 SKILL.md 技能目录（相对路径，必须在插件根目录内）。
  - `contributes.mcpServers`：与用户 MCP 配置同一格式（stdio 命令或 HTTPS 地址），`command`、`args`、`env` 中的 `${pluginRoot}` 展开为插件目录。
  - 分别受 `agent.tools`、`agent.skills`、`mcp.local`（stdio）/ `mcp.remote`（HTTP）权限约束，未授予的贡献不会交给 Agent。
- **插件进程**：`pi.agent.registerTool({ name, run })` 把处理函数绑定到 manifest 中声明的工具；`run(input)` 可以返回字符串、`{ content: [{ type: 'text', text }] }` 或任意 JSON。结果转为文本（≤ 128 KiB），超时 120 秒。面板不能注册工具。另补上了进程侧的 `pi.git.push`。
- **交付给 pi 会话**：Agent Host 在创建会话运行时向 Main 取一次贡献（Main 会等注册表重载完成）；插件工具以 `<插件 id>__<工具名>` 原生注册（`toolDelivery: 'native'`），技能通过 `additionalSkillPaths` 加入，MCP 服务器以 `<插件 id>_<服务器 id>` 并入 MCP 运行时，调用走现有 MCP 审批。插件启用、停用后对新建的会话生效。
- **调用路径**：pi → ToolGate → Agent Host → Main（按声明的 schema 再校验一次、检查授权）→ 插件进程 → 结果以"不可信数据"标注返回模型；每次调用写入审计（`tool:<名称>`）。插件的 `pi.fs` / `pi.git` 作用于窗口当前打开的项目，因此只有该项目中的会话可以调用插件工具，其他项目的后台会话会被拒绝。
- **MCP 桥**（`src/agent-host/plugin-tool-mcp-bridge.ts`）：给 `toolDelivery: 'mcp'` 的运行时用，把插件工具作为 MCP 服务器暴露（`tools/list`、`tools/call`），每次调用同样经过 ToolGate。运行时描述符增加 `toolDelivery` 与 `skills` 字段，pi 为 `native` / `native`。
- **假运行时契约测试**（`src/agent-host/fake-runtime.test.ts`）：一个不依赖 pi 的运行时，用自己的工具名（`RunShell`、`WriteFile`、MCP 工具），通过类别映射进入 ToolGate，经 MCP 桥调用插件工具，并把原生事件归一化为 `ConversationNode`；覆盖三个档位和拒绝。
- **顺带修复**：会话会反复重发相同的包根目录，此前每次都会清空注册表、销毁面板并重启所有插件进程（插件工具调用时尤其明显）。现在同一会话身份下重复的根目录被忽略；注册表重载期间插件进程保持运行，重载完成后只重启真正变化的插件。
- 未做：`pi.agent.onTurnEnd`、插件 MCP 服务器在 MCP 设置页中的展示、接入第二个真实运行时。



- **manifest**：插件目录里没有 `pi-desktop.json` 时读取 `manifest.json`；只有带 `schemaVersion` 和 `id` 的 `manifest.json` 才被当作插件（避免误读网页应用等同名文件）。解析前先做归一化（`src/main/manifest-compat.ts`）：
  - 忽略描述性字段：`author`、`homepage`、`repository`、`icon`、`i18n`、`enabledByDefault`、`activationEvents`、`fs`、`net`；`engines` 可省略。
  - `ui.panel`（独立浮动窗口）在工作台中以 id 为 `panel` 的视图显示；`pi.ui.openPanel()` 打开它。来自 `manifest.json` 的视图默认不需要打开项目（`onApp`）。
  - 命令 id 可以带点（`hello.open`），`category` 忽略。
  - `agentTools[].schema` 作为 `parameters`；`risk` 忽略（插件自报的风险不降低审批，见 §16）。
  - `skills` 接受单个 `.md` 文件、目录或 `{ path }`；pi 原生支持单文件技能。
  - `mcpServers` 接受数组形式；插件内相对路径的命令从插件目录运行；`env` / `headers` 中的 `{ "setting": "key" }` 在交付给 Agent 时取该插件的设置值。
  - `settings`：`string`、`number`、`boolean`、`select` 在设置 → Desktop 插件中直接编辑；`json`、`shortcut` 只显示，由插件自己修改。
  - 主题见 §18。不支持的贡献点——场景主题、常驻服务、消息总线、Agent 扩展模块、模型提供方、外部会话来源、全局快捷键——被忽略，并在插件行中逐条以警告列出，不会让整个插件加载失败。
- **权限别名**：`agent.tool.register` → `agent.tools`，`agent.prompt.inject` → `agent.skills`，`mcp.server.local` / `mcp.server.remote` → `mcp.local` / `mcp.remote`，`ui.panel` → `ui.view`。其余未实现的权限在授权界面标为"此版本不支持，不会授予"。
- **插件进程 `pi`**：
  - `pi.plugin.getId()`（同步）、`getSettings()`、`setSettings(values)`（只接受声明过的键和对应类型）、`getDataPath()`（`~/.pi/agent/pi-desktop/plugin-data/<id>`）。
  - `pi.ui.showToast` / `notify` 接受字符串或 `{ message }`，不再需要 `notify` 权限（提示总带插件名）；`pi.ui.openPanel()`。
  - `pi.agent.registerTool` 接受 `execute(args, context)`（`context.log`），`pi.agent.unregisterTool(name)`。
  - `pi.bus.publish` / `subscribe`、`pi.services.register` 为空实现，保证使用它们的插件能加载；设置页会说明这些能力被忽略。
  - 导出 `onPanelInvoke(channel, payload)` 的插件：视图调用宿主未实现的通道时转发给它（插件与自己的视图通信，不需要额外权限）。
- **视图**：除 `window.piPlugin` 外还提供 `window.pluginBridge`（`invoke(channel, payload)`、`on(event, listener)`）。宿主通道新增 `workspace.get`、`app.getAppearance`、`plugin.getSettings`。`on` 目前只发布 `workspace:changed`。
- 未做：常驻服务、消息总线、`fs.glob` / `fs.remove`、剪贴板、`net.fetch`、`manifest.fs` 的路径范围（我们的文件接口始终限定在当前项目内）、按项目启用插件、`plugin:settingsChanged` 事件。

## 18. 主题

- **内置外观**：设置 → 外观提供"跟随系统 / 浅色 / 深色"主题卡片（带缩略预览）和五种强调色（蓝、紫、绿、橙、粉），每种强调色在浅色和深色下分别调过对比度。设置项为 `accent` 与 `pluginTheme`，旧的偏好文件自动取默认值。
  - 主题 CSS（`.css`，≤ 256 KiB，每个插件最多 8 个）在发现时读取，只提取 `--变量: 值` 声明，而且只保留 `src/shared/theme-tokens.ts` 中列出的设计变量（背景、文字、线条、强调色、状态色、阴影等）。值只能是颜色、数字和颜色函数，含 `url`、`var`、`image`、`expression`、`@`、反斜杠或引号的一律丢弃；选择器和其他规则全部忽略。丢弃的条数在插件行中以警告列出。
  - 渲染层把保留下来的变量设为根元素的内联自定义属性，不注入任何样式表，所以主题无法加载资源、添加选择器或改变布局。
  - 选择插件主题时，界面切到它声明的浅色或深色底色，强调色由主题决定；插件被停用或卸载后自动回落到对应的内置底色和用户选的强调色。

## 19. 宿主视图插件：浏览器与终端

- 浏览器（`works.pi.browser`）和终端（`works.pi.terminal`）以内置插件分发（`resources/plugins/browser`、`resources/plugins/terminal`），和 Git 一样出现在设置 → Desktop 插件中，默认启用，可以关闭，不能卸载。
- 宿主视图：`contributes.views[]` 可以用 `"host": "browser" | "terminal"` 代替 `entry`，表示由宿主绘制的视图而不是沙箱页面；二者必须且只能写一个。只有内置插件并且声明了对应权限才允许：浏览器需要 `browser.control`，终端需要 `terminal.shell`（均为高风险，互不代替），否则整个插件以 `host-view-denied` 拒绝。第三方插件仍只能使用沙箱页面。
- 视图 id 固定为 `works.pi.browser.view` 与 `works.pi.terminal.view`，分别保留给对应的内置插件；其他插件声明同一 id 会以 `reserved-view-id` 拒绝。注册表重新加载期间，内置插件的宿主视图保留，切换会话时不会短暂消失。
- 能力仍在宿主：浏览器的原生视图（WebContentsView）、快照、点击和导航由 `browser-manager` 实现；终端的 PTY 进程由 `terminal-manager` 与终端宿主进程实现，界面是渲染层的终端面板。插件包只决定面板是否出现，以及宿主是否接受对应请求。
- 浏览器关闭时：面板隐藏，正在显示的浏览器被收起，Agent 的 `browser` 工具返回"浏览器插件已关闭"的错误；重新打开后立即恢复，无需重启会话。
- 终端关闭时：面板隐藏，正在运行的终端被关闭（不会在后台留下看不见的 shell），新建终端的请求被拒绝；⌘J 不再打开终端。Agent 的 `bash` 工具不受影响——它不经过终端面板，由工具闸门单独审批。
