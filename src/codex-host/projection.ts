import type { ConversationNode, ToolFileChange, ToolStatus } from '../shared/contracts'
import { t } from '../shared/i18n'

/** The parts of Codex `ThreadItem` the desktop shows; other kinds are skipped. */
export type CodexItem = { type: string; id: string } & Record<string, unknown>

type ToolNode = Extract<ConversationNode, { type: 'tool' }>
const OUTPUT_LIMIT = 64 * 1024

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * `/bin/bash -lc 'npm test'` reads as `npm test`, and so does the PowerShell wrapper Codex uses
 * on Windows: `"C:\\…\\pwsh.exe" -Command 'npm test'`.
 */
export function displayCommand(command: string): string {
  const shell = /^(?:\S*\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command)
  if (shell) return shell[1].replace(/'\\''/g, "'")
  const powershell =
    /^"?(?:[^"]*[\\/])?(?:pwsh|powershell)(?:\.exe)?"?(?:\s+-(?!Command\b)\w+)*\s+-Command\s+(?:'([\s\S]*)'|"([\s\S]*)")$/i.exec(
      command
    )
  if (powershell) return powershell[1]?.replace(/''/g, "'") ?? powershell[2]
  return command
}

function status(value: unknown, exitCode?: unknown): ToolStatus {
  if (value === 'inProgress') return 'running'
  if (value === 'declined') return 'blocked'
  if (value === 'failed') return 'error'
  if (value === 'completed')
    return typeof exitCode === 'number' && exitCode !== 0 ? 'error' : 'success'
  return 'incomplete'
}

function clip(output: string): {
  output: string
  truncated?: boolean
  originalOutputLength?: number
} {
  return output.length > OUTPUT_LIMIT
    ? { output: output.slice(-OUTPUT_LIMIT), truncated: true, originalOutputLength: output.length }
    : { output }
}

function fileChange(change: { path?: unknown; kind?: unknown; diff?: unknown }): ToolFileChange {
  const patch = text(change.diff)
  const lines = patch.split('\n')
  const kind = (change.kind as { type?: string } | undefined)?.type
  return {
    path: text(change.path),
    kind: kind === 'add' ? 'write' : 'edit',
    source: 'applied',
    anchored: /^@@ -\d/m.test(patch),
    patch,
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  }
}

/** Codex thread items folded into the desktop's conversation nodes, in arrival order. */
export class CodexProjection {
  nodes: ConversationNode[] = []
  private readonly index = new Map<string, number>()
  private notices = 0

  clear(): void {
    this.nodes = []
    this.index.clear()
  }

  private upsert(node: ConversationNode): void {
    const at = this.index.get(node.id)
    if (at === undefined) {
      this.index.set(node.id, this.nodes.length)
      this.nodes.push(node)
    } else this.nodes[at] = node
  }

  node(id: string): ConversationNode | undefined {
    const at = this.index.get(id)
    return at === undefined ? undefined : this.nodes[at]
  }

  /** A whole item from `item/started`, `item/completed` or a loaded transcript. */
  item(item: CodexItem, done: boolean, turnId?: string): void {
    // The turn is the unit Codex forks and reverts by.
    const entry = turnId ? { canonicalEntryId: turnId } : {}
    switch (item.type) {
      case 'userMessage': {
        const content = (item.content as { type: string; text?: string }[] | undefined) ?? []
        const images = content.filter((part) => part.type === 'image' || part.type === 'localImage')
        this.upsert({
          id: item.id,
          type: 'user',
          text: content
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n'),
          ...entry,
          ...(images.length ? { imageCount: images.length } : {})
        })
        return
      }
      case 'agentMessage': {
        const previous = this.node(item.id)
        const streamed = previous?.type === 'assistant' ? previous.markdown : ''
        this.upsert({
          id: item.id,
          type: 'assistant',
          markdown: text(item.text) || streamed,
          ...entry,
          ...(done ? {} : { streaming: true })
        })
        return
      }
      case 'reasoning': {
        const summary = (item.summary as string[] | undefined) ?? []
        const content = (item.content as string[] | undefined) ?? []
        const previous = this.node(item.id)
        const body = [...summary, ...content].join('\n\n')
        if (!body && done && previous?.type !== 'think') return
        this.upsert({
          id: item.id,
          type: 'think',
          text: body || (previous?.type === 'think' ? previous.text : ''),
          ...(done ? {} : { streaming: true })
        })
        return
      }
      case 'commandExecution': {
        const previous = this.node(item.id)
        const output =
          text(item.aggregatedOutput) || (previous?.type === 'tool' ? (previous.output ?? '') : '')
        const command = displayCommand(text(item.command))
        this.upsert({
          id: item.id,
          type: 'tool',
          toolCallId: item.id,
          name: 'exec_command',
          intent: 'terminal',
          title: command,
          detail: text(item.cwd),
          ...(output ? clip(output) : {}),
          ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
          status:
            previous?.type === 'tool' && previous.status === 'awaiting-approval' && !done
              ? 'awaiting-approval'
              : status(item.status, item.exitCode)
        })
        return
      }
      case 'fileChange': {
        const changes = ((item.changes as Record<string, unknown>[] | undefined) ?? []).map(
          fileChange
        )
        const previous = this.node(item.id)
        const first = changes[0]
        this.upsert({
          id: item.id,
          type: 'tool',
          toolCallId: item.id,
          name: 'apply_patch',
          intent: 'diff',
          title:
            changes.length === 1 && first
              ? first.path
              : t('修改 {length} 个文件', { length: changes.length }),
          detail: changes.map((change) => change.path).join('\n'),
          ...(changes.length === 1 && first ? { change: first } : {}),
          ...(changes.length > 1
            ? { output: changes.map((change) => change.patch).join('\n') }
            : {}),
          status:
            previous?.type === 'tool' && previous.status === 'awaiting-approval' && !done
              ? 'awaiting-approval'
              : status(item.status)
        })
        return
      }
      case 'mcpToolCall': {
        const result = item.result as { content?: { text?: string }[] } | null
        const error = item.error as { message?: string } | null
        const output =
          error?.message ??
          (result?.content ?? []).map((part) => part.text ?? JSON.stringify(part)).join('\n')
        this.upsert({
          id: item.id,
          type: 'tool',
          toolCallId: item.id,
          name: `${text(item.server)}.${text(item.tool)}`,
          intent: 'generic',
          title: `${text(item.server)} · ${text(item.tool)}`,
          detail: JSON.stringify(item.arguments ?? {}).slice(0, 2000),
          ...(output ? clip(output) : {}),
          status: status(item.status)
        })
        return
      }
      case 'webSearch': {
        this.upsert({
          id: item.id,
          type: 'tool',
          toolCallId: item.id,
          name: 'web_search',
          intent: 'web',
          title: text(item.query) || t('网页搜索'),
          status: done ? 'success' : 'running'
        })
        return
      }
      default:
        return
    }
  }

  /** Streaming text for an assistant message or a reasoning block. */
  delta(itemId: string, kind: 'assistant' | 'think', delta: string): void {
    const previous = this.node(itemId)
    if (kind === 'assistant')
      this.upsert(
        previous?.type === 'assistant'
          ? { ...previous, markdown: previous.markdown + delta, streaming: true }
          : { id: itemId, type: 'assistant', markdown: delta, streaming: true }
      )
    else
      this.upsert(
        previous?.type === 'think'
          ? { ...previous, text: previous.text + delta, streaming: true }
          : { id: itemId, type: 'think', text: delta, streaming: true }
      )
  }

  /** Live command output before the item completes. */
  output(itemId: string, delta: string): void {
    const previous = this.node(itemId)
    if (previous?.type !== 'tool') return
    this.upsert({ ...previous, ...clip((previous.output ?? '') + delta) })
  }

  tool(itemId: string, update: Partial<ToolNode>): void {
    const previous = this.node(itemId)
    if (previous?.type === 'tool') this.upsert({ ...previous, ...update })
  }

  error(id: string, message: string): void {
    this.upsert({ id, type: 'error', message })
  }

  stopped(id: string): void {
    this.upsert({ id, type: 'stopped', message: t('已停止') })
  }

  /** A quiet line in the conversation, e.g. after the engine was restarted. */
  notice(message: string): void {
    this.upsert({ id: `notice-${++this.notices}`, type: 'stopped', message })
  }

  /** Anything still streaming when a turn ends is final as it stands. */
  settle(): void {
    this.nodes = this.nodes.map((node) => {
      if ((node.type === 'assistant' || node.type === 'think') && node.streaming) {
        const { streaming: _streaming, ...rest } = node
        return rest
      }
      if (node.type === 'tool' && ['running', 'awaiting-approval', 'queued'].includes(node.status))
        return { ...node, status: 'incomplete' }
      return node
    })
  }
}
