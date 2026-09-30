import type { ConversationNode } from '../../../shared/contracts'
import type { LiveSessionSummary } from '../../../shared/session-runtime'
import type { SubagentSummary } from '../../../shared/subagent'

export const SUBAGENT_STATE_LABEL: Record<SubagentSummary['state'], string> = {
  queued: '启动中',
  running: '运行中',
  'awaiting-approval': '等待确认',
  idle: '已结束',
  success: '已完成',
  error: '失败',
  stopped: '已停止',
  unavailable: '不可用'
}

/** Reconcile persisted task observations with current, identity-matched runtime activity. */
export function conversationSubagents(
  nodes: readonly ConversationNode[],
  live: readonly LiveSessionSummary[]
): Map<string, SubagentSummary> {
  const result = new Map<string, SubagentSummary>()
  for (const node of nodes) {
    if (node.type !== 'tool' || !node.subagent) continue
    for (const child of node.subagent.children) {
      const previous = result.get(child.id)
      result.set(child.id, {
        ...previous,
        ...child,
        title: previous?.prompt ? previous.title : child.title,
        prompt: previous?.prompt ?? child.prompt,
        ...(node.status === 'error' && child.state === 'queued'
          ? { state: 'error', output: node.output }
          : {}),
        ...(node.subagent.operation === 'send' ? { output: child.output } : {})
      })
    }
  }
  for (const resident of live) {
    const id = resident.sessionTask?.taskId
    const previous = id ? result.get(id) : undefined
    const progress = resident.sessionTask?.progress
    if (
      !id ||
      !previous ||
      !progress ||
      previous.workerId !== resident.workerId ||
      previous.sessionId !== resident.sessionId ||
      previous.generation !== resident.generation
    )
      continue
    const fullResult =
      progress.state === 'success' && previous.state === 'success' && previous.output
    result.set(id, {
      ...previous,
      ...progress,
      title: previous.title,
      prompt: previous.prompt,
      output: fullResult ? previous.output : progress.output,
      truncated: fullResult ? previous.truncated : progress.truncated
    })
  }
  // A historical dispatch is an observation, not proof that its process still runs.
  if (live.length > 0)
    for (const [id, child] of result) {
      // Desktop children carry a resident generation. SDK-native children are owned
      // by their parent runtime and must retain that runtime's observed state.
      if (
        !child.workerId ||
        child.generation === undefined ||
        !['queued', 'running', 'awaiting-approval'].includes(child.state)
      )
        continue
      const resident = live.find(
        (session) =>
          session.workerId === child.workerId &&
          session.sessionId === child.sessionId &&
          session.generation === child.generation
      )
      if (!resident)
        result.set(id, { ...child, state: 'unavailable', activity: '运行连接已断开，保留最后记录' })
    }
  return result
}
