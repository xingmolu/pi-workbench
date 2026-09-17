import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { getSessionTaskCapabilityClient } from './session-task-runtime-client'

const SESSION_TASK_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal('spawn'),
    Type.Literal('send'),
    Type.Literal('status'),
    Type.Literal('wait'),
    Type.Literal('result'),
    Type.Literal('cancel'),
    Type.Literal('list'),
    Type.Literal('release')
  ]),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 45_000 }))
})

type SessionTaskParams = {
  action: 'spawn' | 'send' | 'status' | 'wait' | 'result' | 'cancel' | 'list' | 'release'
  taskId?: string
  prompt?: string
  timeoutMs?: number
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
    case 'list':
      return { action: 'list' as const }
  }
}

export function createSessionTaskExtension(): InlineExtension {
  return {
    name: 'pi-desktop-session-task',
    factory: (pi) => {
      pi.registerTool({
        name: 'session_task',
        label: '后台 Agent',
        description:
          'Create and supervise bounded background Agent sessions in the same project. Use spawn for independent work, wait/status to supervise, result for the canonical completed reply, send for a follow-up, cancel to stop work, and release only after the task is settled. Background workers cannot recursively spawn more workers.',
        promptSnippet: 'Delegate independent coding/research work to background Agent sessions.',
        promptGuidelines: [
          'Use session_task spawn only for work that can proceed independently; keep dependent reasoning in the current session.',
          'After spawn, use wait or status rather than repeatedly polling. Read result only after completion; ambiguous/no-result must not be guessed.',
          'A cancelled or interrupted side-effecting SessionTask call can have an unknown outcome; reconcile with list/status before retrying.',
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
  }
}
