import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { getSessionTaskCapabilityClient } from './session-task-runtime-client'

const SESSION_TASK_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal('delegate'),
    Type.Literal('send'),
    Type.Literal('supervise'),
    Type.Literal('collect'),
    Type.Literal('cancel'),
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
  action: 'delegate' | 'send' | 'supervise' | 'collect' | 'cancel' | 'release'
  taskId?: string
  prompt?: string
  tasks?: string[]
  timeoutMs?: number
  mode?: 'snapshot' | 'any' | 'all'
}

function operation(params: SessionTaskParams) {
  switch (params.action) {
    case 'delegate':
      if (!params.tasks?.length || params.tasks.length > 4) throw new Error('delegate 需要 1-4 个 tasks')
      if (params.tasks.some((task) => !task.trim())) throw new Error('delegate tasks 不能为空')
      return { action: 'delegate' as const, tasks: params.tasks }
    case 'send':
      if (!params.taskId) throw new Error('send 需要 taskId')
      if (!params.prompt?.trim()) throw new Error('send 需要 prompt')
      return { action: 'send' as const, taskId: params.taskId, prompt: params.prompt }
    case 'supervise':
      return {
        action: 'supervise' as const,
        mode: params.mode ?? 'snapshot',
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      }
    case 'collect':
      return { action: 'collect' as const }
    case 'cancel':
    case 'release':
      if (!params.taskId) throw new Error(`${params.action} 需要 taskId`)
      return { action: params.action, taskId: params.taskId }
  }
}

export function registerSessionTaskTool(pi: ExtensionAPI): void {
  if (process.env.PI_DESKTOP_SESSION_WORKER !== '1') return

  pi.registerTool({
    name: 'session_task',
    label: '后台 Agent',
    description:
      'Delegate one to four independent tasks to background Agent sessions, supervise their progress, collect canonical results, send follow-up instructions, cancel work, and release settled task relationships.',
    promptSnippet: 'Delegate independent work to background Agent sessions and coordinate the results.',
    promptGuidelines: [
      'Use delegate for 1-4 independent tasks that can start without each other\'s results. For dependent work, keep it in the current session or delegate the next step after collecting the prerequisite result.',
      'Delegate admission may partially succeed. Preserve spawnedTaskIds/failedIndexes and do not assume an interrupted response means no worker was created.',
      'Use supervise snapshot for one aggregate status view, any to continue when the first task settles, or all to wait for every task. Do not manually poll individual tasks.',
      'Use collect to read canonical results for the current owned tasks. Treat ambiguous/no-result/error outcomes as explicit instead of guessing missing text.',
      'Use send for follow-up instructions and cancel to stop a specific child. Release a settled relationship only when no further follow-up is needed.',
      'If an interrupted side-effecting call has an unknown outcome, reconcile with supervise snapshot before retrying.',
      'Background workers inherit the parent project, model and permission mode and cannot recursively delegate more workers.'
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
