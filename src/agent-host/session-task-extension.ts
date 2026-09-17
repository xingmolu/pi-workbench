import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { getSessionTaskCapabilityClient } from './session-task-runtime-client'

const SESSION_TASK_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal('spawn'),
    Type.Literal('send'),
    Type.Literal('status'),
    Type.Literal('wait'),
    Type.Literal('supervise'),
    Type.Literal('result'),
    Type.Literal('cancel'),
    Type.Literal('list'),
    Type.Literal('release')
  ]),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 45_000 })),
  mode: Type.Optional(
    Type.Union([Type.Literal('snapshot'), Type.Literal('any'), Type.Literal('all')])
  )
})

type SessionTaskParams = {
  action:
    | 'spawn'
    | 'send'
    | 'status'
    | 'wait'
    | 'supervise'
    | 'result'
    | 'cancel'
    | 'list'
    | 'release'
  taskId?: string
  prompt?: string
  timeoutMs?: number
  mode?: 'snapshot' | 'any' | 'all'
}

function operation(params: SessionTaskParams) {
  switch (params.action) {
    case 'spawn':
      if (!params.prompt?.trim()) throw new Error('spawn 需要 prompt')
      return { action: 'spawn' as const, prompt: params.prompt }
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
      'Create and supervise bounded background Agent sessions in the same project. Use spawn for independent work; supervise snapshot/any/all to observe a task set without polling; result for canonical completed replies; send for follow-up; cancel to stop work; release only after settlement. Background workers cannot recursively spawn more workers.',
    promptSnippet: 'Delegate independent coding/research work to background Agent sessions.',
    promptGuidelines: [
      'Use session_task spawn only for work that can proceed independently; keep dependent reasoning in the current session.',
      'Prefer supervise mode any/all for multiple tasks instead of manually polling status. Use snapshot for one bounded aggregate view.',
      'Read result only after completion; ambiguous/no-result must not be guessed.',
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
