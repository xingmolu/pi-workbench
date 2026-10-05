import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationNode, ToolIntent, ToolStatus } from '../shared/contracts'
import type { SubagentSummary } from '../shared/subagent'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
export function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return JSON.stringify(value ?? '')
  return value
    .map((item) => {
      const block = record(item)
      return typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join('\n')
}
export function intent(name: string): ToolIntent {
  if (/Bash|terminal/i.test(name)) return 'terminal'
  if (/Write|Edit|NotebookEdit/.test(name)) return 'diff'
  if (/Read/.test(name)) return 'read'
  if (/Grep|Glob/.test(name)) return 'search'
  if (/browser|Web/.test(name)) return 'web'
  if (/computer/.test(name)) return 'desktop'
  return 'generic'
}

/** One projection per chain. Stream blocks reconcile with final native transcript UUIDs. */
export class ClaudeProjection {
  nodes: ConversationNode[] = []
  readonly children = new Map<string, ClaudeProjection>()
  readonly tasks = new Map<string, SubagentSummary>()
  readonly agentInputs = new Map<string, { title?: string; prompt?: string }>()
  private streamMessageId = ''
  private streamed = new Map<number, string>()
  private toolInputs = new Map<string, string>()
  clear(): void {
    this.nodes = []
    this.children.clear()
    this.tasks.clear()
    this.agentInputs.clear()
    this.streamed.clear()
    this.toolInputs.clear()
  }
  upsert(node: ConversationNode): void {
    const index = this.nodes.findIndex((value) => value.id === node.id)
    if (index === -1) this.nodes.push(node)
    else this.nodes[index] = node
  }
  tool(id: string, patch: Partial<Extract<ConversationNode, { type: 'tool' }>>): void {
    const prior = this.nodes.find((node) => node.type === 'tool' && node.toolCallId === id)
    if (prior?.type === 'tool') this.upsert({ ...prior, ...patch })
  }
  finish(status: ToolStatus = 'incomplete', includeChildren = false): void {
    this.nodes = this.nodes.map((node) => {
      if (node.type === 'assistant' || node.type === 'think') return { ...node, streaming: false }
      if (
        node.type === 'tool' &&
        ['running', 'queued', 'waiting-resource', 'awaiting-approval'].includes(node.status)
      )
        return { ...node, status }
      return node
    })
    if (includeChildren) for (const child of this.children.values()) child.finish(status, true)
  }
  stopTasks(): void {
    this.finish('incomplete', true)
    for (const [id, task] of this.tasks) {
      if (['running', 'queued', 'awaiting-approval'].includes(task.state))
        this.tasks.set(id, { ...task, state: 'stopped' })
    }
    this.nodes = this.nodes.map((node) =>
      node.type === 'tool' && node.subagent
        ? {
            ...node,
            subagent: {
              ...node.subagent,
              children: node.subagent.children.map((child) => this.tasks.get(child.id) ?? child)
            }
          }
        : node
    )
  }
  load(messages: SessionMessage[]): void {
    this.clear()
    for (const message of messages) this.complete(message)
  }
  accept(message: SDKMessage): void {
    if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
      let child = this.children.get(message.parent_tool_use_id)
      if (!child) {
        child = new ClaudeProjection()
        this.children.set(message.parent_tool_use_id, child)
      }
      child.accept({ ...message, parent_tool_use_id: null } as SDKMessage)
      return
    }
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') {
        this.streamMessageId = event.message.id
        this.streamed.clear()
      } else if (event.type === 'content_block_start') {
        const id = `${this.streamMessageId}:${event.index}`
        this.streamed.set(event.index, id)
        this.block(id, event.content_block, true)
      } else if (event.type === 'content_block_delta') {
        const id = this.streamed.get(event.index)
        const node = this.nodes.find((value) => value.id === id)
        if (!node) return
        if (event.delta.type === 'text_delta' && node.type === 'assistant')
          this.upsert({ ...node, markdown: node.markdown + event.delta.text })
        if (event.delta.type === 'thinking_delta' && node.type === 'think')
          this.upsert({ ...node, text: node.text + event.delta.thinking })
        if (event.delta.type === 'input_json_delta' && node.type === 'tool') {
          const json = (this.toolInputs.get(node.toolCallId) ?? '') + event.delta.partial_json
          this.toolInputs.set(node.toolCallId, json)
          this.upsert({ ...node, detail: json.slice(0, 8000) })
        }
      } else if (event.type === 'content_block_stop') {
        const id = this.streamed.get(event.index)
        const node = this.nodes.find((value) => value.id === id)
        if (node?.type === 'assistant' || node?.type === 'think')
          this.upsert({ ...node, streaming: false })
      }
      return
    }
    if (message.type === 'assistant' || message.type === 'user') this.complete(message)
    if (message.type === 'system' && message.subtype === 'compact_boundary')
      this.upsert({
        id: message.uuid,
        type: 'compaction',
        tokensBefore: message.compact_metadata.pre_tokens
      })
    if (
      message.type === 'system' &&
      ['task_started', 'task_progress', 'task_notification'].includes(message.subtype)
    ) {
      const task = message as Extract<
        SDKMessage,
        { subtype: 'task_started' | 'task_progress' | 'task_notification' }
      >
      const prior = this.tasks.get(task.task_id)
      const next: SubagentSummary = {
        ...prior,
        id: task.task_id,
        title: ('description' in task ? task.description : (prior?.title ?? task.summary)).slice(
          0,
          200
        ),
        state:
          task.subtype === 'task_notification'
            ? ({ completed: 'success', failed: 'error', stopped: 'stopped' } as const)[task.status]
            : 'running',
        sessionId: task.session_id,
        ...('prompt' in task && task.prompt ? { prompt: task.prompt.slice(0, 8000) } : {}),
        ...('summary' in task && task.summary
          ? { activity: task.summary.slice(0, 240), output: task.summary.slice(0, 32000) }
          : {}),
        ...('usage' in task && task.usage ? { tokens: task.usage.total_tokens } : {})
      }
      this.tasks.set(task.task_id, next)
      if (task.subtype === 'task_notification')
        this.children.get(task.tool_use_id ?? prior?.workerId ?? '')?.finish('incomplete', true)
      const toolId = task.tool_use_id ?? prior?.workerId
      if (toolId) {
        next.workerId = toolId
        const existing = this.nodes.find(
          (node) => node.type === 'tool' && node.toolCallId === toolId
        )
        if (existing?.type === 'tool')
          this.tool(toolId, { subagent: { operation: 'spawn', children: [next] } })
      } else {
        this.upsert({
          id: `task:${task.task_id}`,
          type: 'tool',
          toolCallId: task.task_id,
          name: 'Agent',
          title: next.title,
          intent: 'generic',
          status:
            next.state === 'running'
              ? 'running'
              : next.state === 'success'
                ? 'success'
                : 'incomplete',
          subagent: { operation: 'spawn', children: [next] }
        })
      }
    }
  }
  private complete(message: {
    type: string
    uuid?: string
    message: unknown
    isSynthetic?: boolean
    origin?: unknown
  }): void {
    const payload = record(message.message)
    const content = payload.content
    const hasToolResult =
      Array.isArray(content) && content.some((block) => record(block).type === 'tool_result')
    if (message.type === 'user' && !hasToolResult) {
      if (this.savedTaskNotification(textContent(content))) return
      if (message.isSynthetic || record(message.origin).kind === 'task-notification') return
    }
    if (message.type === 'user' && typeof content === 'string') {
      this.upsert({
        id: message.uuid!,
        type: 'user',
        text: content,
        canonicalEntryId: message.uuid
      })
      return
    }
    if (!Array.isArray(content)) return
    if (message.type === 'user' && !content.some((block) => record(block).type === 'tool_result')) {
      const text = content
        .filter((block) => record(block).type === 'text')
        .map((block) => String(record(block).text ?? ''))
        .join('\n')
      const imageCount = content.filter((block) => record(block).type === 'image').length
      this.upsert({
        id: message.uuid!,
        type: 'user',
        text,
        canonicalEntryId: message.uuid,
        ...(imageCount ? { imageCount } : {})
      })
      return
    }
    content.forEach((block, index) => {
      const value = record(block)
      if (value.type === 'tool_result') {
        const prior = this.nodes.find(
          (node) => node.type === 'tool' && node.toolCallId === value.tool_use_id
        )
        this.tool(String(value.tool_use_id), {
          output: textContent(value.content).slice(0, 32000),
          status:
            prior?.type === 'tool' && prior.status === 'blocked'
              ? 'blocked'
              : value.is_error
                ? 'error'
                : 'success'
        })
        return
      }
      const id = `${message.uuid}:${index}`
      if (message.type === 'assistant') {
        const streamPrefix = typeof payload.id === 'string' ? `${payload.id}:` : undefined
        const nodeType =
          value.type === 'text' ? 'assistant' : value.type === 'thinking' ? 'think' : undefined
        // The CLI may deliver each block as its own message, so its index restarts at 0;
        // fall back to the first still-streamed block of the same kind in that API message.
        const previous =
          this.nodes.find(
            (node) =>
              (node.id === `${streamPrefix}${index}` && node.type === nodeType) ||
              (value.type === 'tool_use' && node.type === 'tool' && node.toolCallId === value.id)
          ) ??
          (streamPrefix && nodeType
            ? this.nodes.find((node) => node.id.startsWith(streamPrefix) && node.type === nodeType)
            : undefined)
        const position = previous ? this.nodes.indexOf(previous) : -1
        if (previous) this.nodes.splice(position, 1)
        this.block(id, value, false, message.uuid, previous?.presentationIdentity ?? previous?.id)
        if (position >= 0) {
          const finalized = this.nodes.pop()
          if (finalized) this.nodes.splice(position, 0, finalized)
        }
      } else if (value.type === 'text')
        this.upsert({ id, type: 'user', text: String(value.text), canonicalEntryId: message.uuid })
      else if (value.type === 'image') {
        const previous = this.nodes.find((node) => node.id === `${message.uuid}:images`)
        this.upsert({
          id: `${message.uuid}:images`,
          type: 'user',
          text: '',
          imageCount: previous?.type === 'user' ? (previous.imageCount ?? 0) + 1 : 1
        })
      }
    })
  }
  private savedTaskNotification(content: string): boolean {
    // SDK history intentionally omits origin/isSynthetic. Recognize the entire native envelope,
    // including its required identity/status fields; ordinary prompts mentioning these tags remain.
    const text = content.trim()
    if (!/^<task-notification>\s[\s\S]*<\/task-notification>$/.test(text)) return false
    const field = (name: string): string | undefined =>
      text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
    const id = field('task-id')
    const toolId = field('tool-use-id')
    const status = field('status')
    if (!id || !toolId || !status || !['completed', 'failed', 'stopped'].includes(status))
      return false
    const input = this.agentInputs.get(toolId)
    const summary = field('summary')
    const task: SubagentSummary = {
      id,
      workerId: toolId,
      title:
        input?.title ?? summary?.match(/^Agent "([\s\S]+)" finished$/)?.[1] ?? 'Saved subagent',
      ...(input?.prompt ? { prompt: input.prompt } : {}),
      state: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'stopped',
      ...(summary ? { activity: summary.slice(0, 240) } : {}),
      ...(field('result') ? { output: field('result')!.slice(0, 32000) } : {})
    }
    this.tasks.set(id, task)
    this.tool(toolId, { subagent: { operation: 'observe', children: [task] } })
    return true
  }
  private block(
    id: string,
    block: unknown,
    streaming: boolean,
    canonicalEntryId?: string,
    presentationIdentity?: string
  ): void {
    const value = record(block)
    if (value.type === 'text')
      this.upsert({
        id,
        type: 'assistant',
        markdown: String(value.text ?? ''),
        streaming,
        canonicalEntryId,
        presentationIdentity: presentationIdentity ?? id
      })
    else if (value.type === 'thinking')
      this.upsert({
        id,
        type: 'think',
        text: String(value.thinking ?? ''),
        streaming,
        presentationIdentity: presentationIdentity ?? id
      })
    else if (value.type === 'tool_use') {
      if (['Agent', 'Task'].includes(String(value.name))) {
        const input = record(value.input)
        this.agentInputs.set(String(value.id), {
          ...(typeof input.description === 'string'
            ? { title: input.description.slice(0, 200) }
            : {}),
          ...(typeof input.prompt === 'string' ? { prompt: input.prompt.slice(0, 8000) } : {})
        })
      }
      this.upsert({
        id,
        type: 'tool',
        toolCallId: String(value.id),
        name: String(value.name),
        title: String(value.name),
        intent: intent(String(value.name)),
        detail: JSON.stringify(value.input ?? {}).slice(0, 8000),
        status: 'running',
        presentationIdentity: presentationIdentity ?? id
      })
    }
  }
}
