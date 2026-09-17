import { describe, expect, it, vi } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot, type HostCommand, type HostResult } from '../shared/contracts'
import {
  BackgroundSessionService,
  type BackgroundSessionRuntime
} from './background-session-service'

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    sessionId: 'session-parent',
    generation: 3,
    revision: 1,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/agent',
    project: { path: '/project', name: 'project' },
    sessions: [],
    activeSessionPath: '/sessions/parent.jsonl',
    nodes: [],
    accounts: [],
    models: [],
    activeProvider: 'provider-a',
    activeModel: 'model-a',
    modelAvailability: 'available',
    composeBlockReason: null,
    busy: false,
    status: 'idle',
    approvals: [],
    followUp: [],
    queuedCount: 0,
    permissionMode: 'open',
    metrics: { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    login: { phase: 'idle' },
    loginPrompt: null,
    ...overrides
  }
}

function user(id: string, text: string) {
  return { id: `entry:${id}:user`, type: 'user' as const, text, canonicalEntryId: id }
}

function assistant(id: string, markdown: string) {
  return {
    id: `entry:${id}:assistant:0`,
    type: 'assistant' as const,
    markdown,
    canonicalEntryId: id,
    streaming: false
  }
}

function fixture() {
  const residents = new Map<string, AgentSnapshot>()
  residents.set('parent-worker', snapshot())
  const child = snapshot({
    sessionId: 'session-child',
    generation: 8,
    activeSessionPath: null,
    permissionMode: 'open'
  })
  const requestWorker = vi.fn(
    async (
      workerId: string,
      command: HostCommand,
      _expectedIdentity?: { sessionId: string | null; generation: number }
    ): Promise<HostResult> => {
      const current = residents.get(workerId)
      if (!current) throw new Error('missing worker')
      if (command.type === 'prompt:send') {
        residents.set(workerId, {
          ...current,
          revision: current.revision + 1,
          busy: true,
          status: 'running'
        })
      }
      const next = residents.get(workerId)!
      return {
        kind: 'ack',
        sessionId: next.sessionId,
        generation: next.generation,
        revision: next.revision
      }
    }
  )
  const runtime: BackgroundSessionRuntime = {
    openBackground: async () => {
      residents.set('child-worker', child)
      return { workerId: 'child-worker', snapshot: child }
    },
    requestWorker,
    tryGetSnapshot: (workerId) => residents.get(workerId) ?? null
  }
  return {
    service: new BackgroundSessionService(runtime),
    residents,
    requestWorker
  }
}

describe('background session canonical result', () => {
  it('returns only the completed canonical assistant reply for the dispatched prompt', async () => {
    const { service, residents } = fixture()
    const handle = await service.spawnFromParent('parent-worker', 'inspect tests')
    const current = residents.get(handle.workerId)!
    residents.set(handle.workerId, {
      ...current,
      revision: current.revision + 1,
      busy: false,
      status: 'idle',
      nodes: [
        user('user-task', 'inspect tests'),
        { id: 'think', type: 'think', text: 'private reasoning' },
        assistant('assistant-task', 'Found the failing test.')
      ]
    })

    expect(service.result(handle)).toEqual({
      outcome: 'ready',
      entryId: 'assistant-task',
      markdown: 'Found the failing test.',
      originalLength: 23,
      truncated: false
    })
  })

  it('fails closed when another canonical user turn wins the dispatch boundary', async () => {
    const { service, residents } = fixture()
    const handle = await service.spawnFromParent('parent-worker', 'task prompt')
    const current = residents.get(handle.workerId)!
    residents.set(handle.workerId, {
      ...current,
      busy: false,
      status: 'idle',
      nodes: [
        user('manual-user', 'manual interruption'),
        assistant('manual-answer', 'manual answer'),
        user('task-user', 'task prompt'),
        assistant('task-answer', 'task answer')
      ]
    })

    expect(service.result(handle)).toEqual({ outcome: 'ambiguous' })
  })

  it('moves the private cursor forward when the parent sends follow-up work', async () => {
    const { service, residents } = fixture()
    const handle = await service.spawnFromParent('parent-worker', 'first')
    const running = residents.get(handle.workerId)!
    residents.set(handle.workerId, {
      ...running,
      busy: false,
      status: 'idle',
      nodes: [user('user-1', 'first'), assistant('answer-1', 'first answer')]
    })
    expect(service.result(handle)).toMatchObject({
      outcome: 'ready',
      entryId: 'answer-1',
      markdown: 'first answer'
    })

    await service.send(handle, 'second')
    const followUp = residents.get(handle.workerId)!
    residents.set(handle.workerId, {
      ...followUp,
      busy: false,
      status: 'idle',
      nodes: [
        user('user-1', 'first'),
        assistant('answer-1', 'first answer'),
        user('user-2', 'second'),
        assistant('answer-2', 'second answer')
      ]
    })

    expect(service.result(handle)).toMatchObject({
      outcome: 'ready',
      entryId: 'answer-2',
      markdown: 'second answer'
    })
  })

  it('bounds returned markdown and does not expose a partial result while the task is running', async () => {
    const { service, residents } = fixture()
    const handle = await service.spawnFromParent('parent-worker', 'large result')

    expect(service.result(handle)).toEqual({ outcome: 'pending' })

    const markdown = 'x'.repeat(40_000)
    const current = residents.get(handle.workerId)!
    residents.set(handle.workerId, {
      ...current,
      busy: false,
      status: 'idle',
      nodes: [user('user-large', 'large result'), assistant('answer-large', markdown)]
    })
    const result = service.result(handle)
    expect(result).toMatchObject({
      outcome: 'ready',
      entryId: 'answer-large',
      originalLength: 40_000,
      truncated: true
    })
    expect(result.markdown).toHaveLength(32_000)
  })
})
