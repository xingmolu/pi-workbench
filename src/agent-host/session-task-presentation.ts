import type { SubagentOperation, SubagentSummary } from '../shared/subagent'
import {
  sessionTaskCollectionSchema,
  sessionTaskDelegationSchema,
  sessionTaskSuperviseResultSchema,
  sessionTaskViewSchema,
  type SessionTaskViewWire
} from '../shared/session-task-capability'

const OPERATIONS = {
  delegate: 'spawn',
  supervise: 'observe',
  collect: 'collect',
  send: 'send',
  cancel: 'cancel',
  release: 'release'
} as const
export function sessionTaskPresentation(
  name: string,
  args: unknown,
  callId: string
): SubagentOperation | undefined {
  if (name !== 'session_task' || !args || typeof args !== 'object') return undefined
  const params = args as Record<string, unknown>
  if (typeof params.action !== 'string' || !Object.hasOwn(OPERATIONS, params.action))
    return undefined
  const operation = OPERATIONS[params.action as keyof typeof OPERATIONS]
  const children: SubagentSummary[] =
    operation === 'spawn' && Array.isArray(params.tasks)
      ? params.tasks
          .slice(0, 4)
          .filter((task): task is string => typeof task === 'string')
          .map((prompt, index) => ({
            id: `${callId}:${index}`,
            title: prompt.trim().split('\n')[0].slice(0, 200),
            prompt: prompt.slice(0, 8000),
            state: 'queued'
          }))
      : []
  return { operation, children }
}

function taskSummary(task: SessionTaskViewWire, previous?: SubagentSummary): SubagentSummary {
  return {
    id: task.taskId,
    title: previous?.title ?? '子 Agent',
    ...(previous?.prompt ? { prompt: previous.prompt } : {}),
    state: task.state,
    workerId: task.workerId,
    sessionId: task.sessionId,
    generation: task.generation,
    startedAt: task.createdAt
  }
}

/** Decode structured SDK details before display text is truncated. No JSON guessing in the UI. */
export function sessionTaskResultPresentation(
  operation: SubagentOperation | undefined,
  details: unknown
): SubagentOperation | undefined {
  if (!operation) return undefined
  const delegation = sessionTaskDelegationSchema.safeParse(details)
  if (delegation.success)
    return {
      ...operation,
      children: delegation.data.items.map((item) => {
        const previous = operation.children[item.index]
        return item.status === 'spawned'
          ? taskSummary(item.task, previous)
          : {
              id: previous?.id ?? `failed:${item.index}`,
              title: previous?.title ?? '子 Agent',
              prompt: previous?.prompt,
              state: 'error' as const,
              output: item.error
            }
      })
    }
  const collection = sessionTaskCollectionSchema.safeParse(details)
  if (collection.success)
    return {
      ...operation,
      children: collection.data.items.map(({ task, result }) => ({
        ...taskSummary(task),
        state:
          result.outcome === 'ready'
            ? 'success'
            : ['error', 'stopped', 'unavailable'].includes(result.outcome)
              ? (result.outcome as 'error' | 'stopped' | 'unavailable')
              : task.state,
        ...(result.markdown ? { output: result.markdown, truncated: result.truncated } : {}),
        ...(result.outcome === 'ambiguous' ? { activity: '结果不明确，请查看子会话' } : {})
      }))
    }
  const supervision = sessionTaskSuperviseResultSchema.safeParse(details)
  if (supervision.success)
    return { ...operation, children: supervision.data.tasks.map((task) => taskSummary(task)) }
  const task = sessionTaskViewSchema.safeParse(details)
  return task.success ? { ...operation, children: [taskSummary(task.data)] } : operation
}
