import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { getSessionTaskCapabilityClient } from './session-task-runtime-client'

const SESSION_TASK_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal('spawn'),
    Type.Literal('delegate'),
    Type.Literal('send'),
    Type.Literal('status'),
    Type.Literal('wait'),
    Type.Literal('supervise'),
    Type.Literal('collect'),
    Type.Literal('result'),
    Type.Literal('cancel'),
    Type.Literal('list'),
    Type.Literal('release')
  ]),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
  tasks: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200_000 }), {
      minItems: 1,
      maxItems: 4
    })
  ),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 45_000 })),
  mode: Type.Optional(
    Type.Union([Type.Literal('snapshot'), Type.Literal('any'), Type.Literal('all')])
  )
})

type SessionTaskParams = {
  action:
    | 'spawn'
    | 'delegate'
    | 'send'
    | 'status'
    | 'wait'
    | 'supervise'
    | 'collect'
    | 'result'
    | 'cancel'
    | 'list'
    | 'release'
  taskId?: string
  prompt?: string
  tasks?: string[]
  timeoutMs?: number
  mode?: 'snapshot' | 'any' | 'all'
}

function operation(params: SessionTaskParams) {
  switch (params.action) {
    case 'spawn':
      if (!params.prompt?.trim()) throw new Error('spawn 需要 prompt')
      return { action: 'spawn' as const, prompt: params.prompt }
    case 'delegate':
      if (!params.tasks?.length || params.tasks.length > 4) throw new Error('delegate 需要 1-4 个 tasks')
      if (params.tasks.some((task) => !task.trim())) throw new Error('delegate tasks 不能为空')
      return { action: 'delegate' as const, tasks: params.tasks }
    case 'send':
      if (!params.taskId) throw new Error('send 需要 taskId')
      if (!params.prompt?.trim()) throw new Error('send 需要 prompt')
      return { action: 'send' as const, taskId: params.taskId, prompt: params.prompt }
    case 'status':
    case 'result':
    case 'cancel':
    case 'release':
      if (!params.taskId) throw new Error(`${params.action} 需要 taskId`)
      return { action: params.action, taskId: params.taskId }
    case 'wait':
      if (!params.taskId) throw new Error('wait 需要 taskId')
      return {
        action: 'wait' as const,
        taskId: params.taskId,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      }
    case 'supervise':
      return {
        action: 'supervise' as const,
        mode: params.mode ?? 'snapshot',
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      }
    case 'collect':
      return { action: 'collect' as const }
    case 'list':
      return { action: 'list' as const }
  }
}

export function registerSessionTaskTool(pi: ExtensionAPI): void {
  // The lobby Agent Host has no resident worker identity and therefore no Main
  // SessionTask route. Only per-session utility workers are allowed to expose it.
  if (process.env.PI_DESKTOP_SESSION_WORKER !== '1') return

  pi.registerTool({
    name: 'session_task',
    label: '后台 Agent',
    description:
      'Create and supervise bounded background Agent sessions in the same project. Use delegate for 1-4 independent tasks, spawn for one task, supervise snapshot/any/all to observe them without polling, and collect to read canonical results in one bounded response. Use send for follow-up, cancel to stop work, and release only after settlement. Background workers cannot recursively spawn more workers.',
    promptSnippet: 'Delegate independent coding/research work to background Agent sessions.',
    promptGuidelines: [
      'Use delegate when 2-4 tasks are independent and can start without each other\'s results. Keep dependent reasoning in the current session or sequence it explicitly.',
      'Delegate admission is bounded and may partially succeed. Preserve returned spawnedTaskIds/failedIndexes and never assume a failed response means no worker was created.',
      'Prefer supervise mode any/all for multiple tasks instead of manually polling status. Use snapshot for one bounded aggregate view.',
      'After supervision, prefer collect to read the current canonical results for all owned tasks in one call. Treat attention outcomes such as ambiguous/no-result/error as explicit, never guess missing text.',
      'A cancelled or interrupted side-effecting SessionTask call can have an unknown outcome; reconcile with supervise/list/status before retrying.',
      'Background workers inherit the parent project, model and permission mode and cannot spawn nested workers.'
    ],
    executionMode: 'sequential',
    parameters: SESSION_TASK_PARAMETERS,
    execute: async (_toolCallId, params, signal) => {
      const data = await getSessionTaskCapabilityClient().request(
        operation(params as SessionTaskParams),
        signal
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        details: data
      }
    }
  })
}

export function createSessionTaskExtension(): InlineExtension {
  return {
    name: 'pi-desktop-session-task',
    factory: registerSessionTaskTool
  }
}
