import type { PermissionMode } from '../shared/contracts'
import { t } from '../shared/i18n'

/**
 * Semantic tool categories. Permission decisions only look at the category, so any agent
 * runtime can plug in by mapping its own tool names (see `piToolCategory`).
 */
export type ToolCategory =
  'read' | 'shell' | 'file.write' | 'file.edit' | 'browser' | 'computer' | 'mcp' | 'plugin' | 'task'

export type GatedToolCall = {
  sessionId: string | null
  toolCallId: string
  /** The runtime's own tool name, kept for rules, presentation and audit. */
  tool: string
  category: ToolCategory
  input: unknown
  cwd: string
  /** Plugin tools that declare themselves read-only skip confirmation at the ask level. */
  readOnly?: boolean
}

export type ToolGateDecision = { decision: 'allow' } | { decision: 'deny'; reason: string }

export type ToolGateDependencies = {
  mode(): PermissionMode
  /** The project's own rules (and the auto level's safe defaults) for shell and file tools. */
  rulesAllow(call: GatedToolCall, auto: boolean): boolean
  confirm(call: GatedToolCall): Promise<boolean>
  /** Takes the project write lock; rejects when the call is cancelled while waiting. */
  acquire(call: GatedToolCall): Promise<void>
  release(toolCallId: string): void
  checkpoint: {
    capture(call: GatedToolCall): void
    settle(sessionId: string, toolCallId: string): void
  }
  onWaiting?(toolCallId: string): void
  onStarted?(toolCallId: string): void
}

const LOCKED: ReadonlySet<ToolCategory> = new Set(['shell', 'file.write', 'file.edit'])
const CHECKPOINTED: ReadonlySet<ToolCategory> = new Set(['file.write', 'file.edit'])

/**
 * Every tool call passes here before and after it runs, whatever agent runtime issued it:
 * approval level and project rules, confirmation when needed, the project write lock, and a
 * checkpoint before file writes. MCP calls approve and lock inside the MCP runtime, where the
 * server and tool are known, so the gate lets them through.
 */
export class ToolGate {
  constructor(private readonly dependencies: ToolGateDependencies) {}

  async before(call: GatedToolCall): Promise<ToolGateDecision> {
    if (call.category === 'read' || call.category === 'task' || call.category === 'mcp')
      return { decision: 'allow' }

    if (!(await this.approved(call)))
      return { decision: 'deny', reason: t('用户拒绝了这次工具调用') }

    if (LOCKED.has(call.category)) {
      if (!call.sessionId) return { decision: 'deny', reason: t('会话已结束') }
      this.dependencies.onWaiting?.(call.toolCallId)
      try {
        await this.dependencies.acquire(call)
      } catch {
        return { decision: 'deny', reason: t('项目操作已取消') }
      }
      if (CHECKPOINTED.has(call.category)) this.dependencies.checkpoint.capture(call)
      this.dependencies.onStarted?.(call.toolCallId)
    }
    return { decision: 'allow' }
  }

  after(call: {
    sessionId: string | null
    toolCallId: string
    category: ToolCategory
    ok: boolean
  }): void {
    if (CHECKPOINTED.has(call.category) && call.sessionId)
      this.dependencies.checkpoint.settle(call.sessionId, call.toolCallId)
    if (call.category !== 'mcp') this.dependencies.release(call.toolCallId)
  }

  private async approved(call: GatedToolCall): Promise<boolean> {
    const mode = this.dependencies.mode()
    switch (call.category) {
      // Driving the user's desktop is confirmed at every level.
      case 'computer':
        return this.dependencies.confirm(call)
      case 'plugin':
        if (mode !== 'ask' || call.readOnly) return true
        return this.dependencies.confirm(call)
      case 'browser':
        return mode === 'open' || this.dependencies.confirm(call)
      default:
        return (
          mode === 'open' ||
          this.dependencies.rulesAllow(call, mode === 'auto') ||
          this.dependencies.confirm(call)
        )
    }
  }
}

const READ_ONLY_BROWSER_ACTIONS = new Set(['tabs', 'snapshot', 'screenshot', 'wait'])

/**
 * Maps pi's tool names onto categories. Other runtimes provide their own mapping.
 * `pluginTool` resolves names registered for plugin agent tools.
 */
export function piToolCategory(
  toolName: string,
  input: unknown,
  pluginTool: (name: string) => { readOnly: boolean } | undefined = () => undefined
): { category: ToolCategory; readOnly?: boolean } {
  const action =
    input && typeof input === 'object' ? (input as Record<string, unknown>).action : undefined
  switch (toolName) {
    case 'bash':
    case 'powershell':
      return { category: 'shell' }
    case 'write':
      return { category: 'file.write' }
    case 'edit':
      return { category: 'file.edit' }
    case 'browser':
      return {
        category:
          typeof action === 'string' && READ_ONLY_BROWSER_ACTIONS.has(action) ? 'read' : 'browser'
      }
    case 'computer':
      return { category: action === 'act' ? 'computer' : 'read' }
    case 'mcp':
      return { category: 'mcp' }
    case 'session_task':
      return { category: 'task' }
  }
  const plugin = pluginTool(toolName)
  if (plugin) return { category: 'plugin', readOnly: plugin.readOnly }
  return { category: 'read' }
}
