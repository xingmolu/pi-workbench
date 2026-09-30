import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Options, Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeHost } from './host'
import { InputStream } from './input'

let close: (() => Promise<unknown>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

it('retains child approval and mutation lease across a parent result until that child tool settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-child-lease-'))
  const storage = {
    root,
    config: join(root, 'config'),
    sessions: join(root, 'sessions'),
    cache: join(root, 'cache')
  }
  const cwd = join(root, 'project')
  await Promise.all(
    [storage.config, storage.sessions, storage.cache, cwd].map((path) => mkdir(path))
  )
  let events = new InputStream<SDKMessage>()
  let nativeOptions: Options = {}
  const mutationMessages: { action: unknown; requestId: unknown }[] = []
  let host!: ClaudeHost
  const sdkQuery: typeof query = ({ options }) => {
    nativeOptions = options ?? {}
    events = new InputStream<SDKMessage>()
    const current = events
    // This interleaving is deliberately injected: native SDK end-to-end behavior is covered
    // separately. A parent result must never stand in for a child's PostToolUse hook.
    return {
      [Symbol.asyncIterator]: () => current[Symbol.asyncIterator](),
      supportedModels: async () => [
        { value: 'sonnet', displayName: 'Test model', description: '' }
      ],
      accountInfo: async () => ({ apiKeySource: 'env' }),
      setPermissionMode: async () => {},
      close: () => current.close()
    } as unknown as Query
  }
  host = new ClaudeHost({
    storage,
    sdkQuery,
    post(message) {
      if (!message || typeof message !== 'object' || !('type' in message)) return
      const request = message as Record<string, unknown>
      if (request.type === 'plugin-agent-contributions-request')
        queueMicrotask(() =>
          host.accept({
            type: 'plugin-agent-contributions',
            requestId: request.requestId,
            contributions: { tools: [], skillPaths: [], mcpServers: {} }
          })
        )
      if (request.type === 'project-mutation') {
        mutationMessages.push({ action: request.action, requestId: request.requestId })
        if (request.action === 'acquire')
          queueMicrotask(() =>
            host.accept({
              type: 'project-mutation-response',
              requestId: request.requestId,
              ok: true
            })
          )
      }
    }
  })
  close = async () => {
    await host.handle({ type: 'runtime:shutdown' })
    await rm(root, { recursive: true, force: true })
  }
  await host.handle({ type: 'bootstrap' })
  await host.handle({ type: 'project:open', cwd })
  await host.handle({ type: 'permission:set', mode: 'ask' })
  const sessionId = host.getState().sessionId!
  events.push({
    type: 'system',
    subtype: 'task_started',
    uuid: randomUUID(),
    session_id: sessionId,
    task_id: 'native-child',
    tool_use_id: 'spawning-tool',
    description: 'Child writing',
    task_type: 'local_agent'
  })
  const controller = new AbortController()
  const pre = nativeOptions.hooks?.PreToolUse?.[0].hooks[0]!
  await pre(
    {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd,
      transcript_path: '/native/transcript',
      tool_name: 'Bash',
      tool_input: { command: 'child mutation' },
      tool_use_id: 'child-write',
      agent_id: 'native-child'
    },
    'child-write',
    { signal: controller.signal }
  )
  expect(mutationMessages.filter((message) => message.action === 'acquire')).toHaveLength(1)
  const permission = nativeOptions.canUseTool!(
    'Bash',
    { command: 'child mutation' },
    {
      signal: controller.signal,
      requestId: 'child-permission',
      toolUseID: 'child-write',
      agentID: 'native-child'
    }
  )
  expect(host.getState().approvals.map((approval) => approval.id)).toEqual(['claude:child-write'])
  events.push({
    type: 'result',
    subtype: 'success',
    uuid: randomUUID(),
    session_id: sessionId,
    is_error: false,
    result: 'Parent complete',
    num_turns: 1,
    modelUsage: {},
    permission_denials: [],
    duration_api_ms: 0
  } as unknown as SDKMessage)
  const start = Date.now()
  while (!host.getState().metrics.turns) {
    if (Date.now() - start > 1000) throw new Error('Parent result not projected')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(mutationMessages.filter((message) => message.action === 'release')).toHaveLength(0)
  expect(host.getState().busy).toBe(true)
  expect(host.getState().approvals.map((approval) => approval.id)).toEqual(['claude:child-write'])
  await host.handle({ type: 'permission:respond', approvalId: 'claude:child-write', allow: true })
  expect(await permission).toMatchObject({ behavior: 'allow' })
  const post = nativeOptions.hooks?.PostToolUse?.[0].hooks[0]!
  await post(
    {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      cwd,
      transcript_path: '/native/transcript',
      tool_name: 'Bash',
      tool_input: { command: 'child mutation' },
      tool_response: 'completed',
      tool_use_id: 'child-write',
      agent_id: 'native-child'
    },
    'child-write',
    { signal: controller.signal }
  )
  expect(mutationMessages.filter((message) => message.action === 'release')).toHaveLength(1)
})
