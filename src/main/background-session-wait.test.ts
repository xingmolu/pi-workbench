import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot } from '../shared/contracts'
import {
  BackgroundSessionService,
  type BackgroundSessionHandle,
  type BackgroundSessionLifecycleListener,
  type BackgroundSessionRuntime
} from './background-session-service'

const handle: BackgroundSessionHandle = {
  workerId: 'worker-1',
  sessionId: 'session-1',
  generation: 3,
  projectPath: '/project'
}

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    sessionId: handle.sessionId,
    generation: handle.generation,
    revision: 1,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/agent',
    project: { path: handle.projectPath, name: 'project' },
    sessions: [],
    activeSessionPath: '/sessions/worker.jsonl',
    nodes: [],
    accounts: [],
    models: [],
    activeProvider: 'provider',
    activeModel: 'model',
    modelAvailability: 'available',
    composeBlockReason: null,
    busy: true,
    status: 'running',
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

function fixture(initial = snapshot()) {
  const residents = new Map<string, AgentSnapshot>([[handle.workerId, initial]])
  const listeners = new Set<BackgroundSessionLifecycleListener>()
  const runtime: BackgroundSessionRuntime = {
    openBackground: async () => {
      throw new Error('unused')
    },
    requestWorker: async () => {
      throw new Error('unused')
    },
    tryGetSnapshot: (workerId) => residents.get(workerId) ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    service: new BackgroundSessionService(runtime),
    listeners,
    emit(next: AgentSnapshot | null): void {
      if (next) residents.set(handle.workerId, next)
      else residents.delete(handle.workerId)
      for (const listener of listeners) listener(handle.workerId, next)
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('background session wait', () => {
  it('resolves from lifecycle events when the exact worker settles', async () => {
    const value = fixture()
    const waiting = value.service.wait(handle, { timeoutMs: 1_000 })

    value.emit(snapshot({ revision: 2, busy: false, status: 'idle' }))

    await expect(waiting).resolves.toMatchObject({
      outcome: 'completed',
      status: { workerId: handle.workerId, status: 'idle', busy: false }
    })
    expect(value.listeners.size).toBe(0)
  })

  it.each([
    ['error' as const, 'error' as const],
    ['stopped' as const, 'stopped' as const]
  ])('returns %s immediately for an already settled worker', async (status, outcome) => {
    const value = fixture(snapshot({ busy: false, status }))

    await expect(value.service.wait(handle, { timeoutMs: 1_000 })).resolves.toMatchObject({
      outcome,
      status: { status }
    })
    expect(value.listeners.size).toBe(0)
  })

  it('fails closed as unavailable when the worker identity changes', async () => {
    const value = fixture()
    const waiting = value.service.wait(handle, { timeoutMs: 1_000 })

    value.emit(
      snapshot({
        sessionId: 'replacement-session',
        generation: handle.generation + 1,
        revision: 2
      })
    )

    await expect(waiting).resolves.toEqual({ outcome: 'unavailable', status: null })
  })

  it('returns a bounded timeout projection without polling', async () => {
    vi.useFakeTimers()
    const value = fixture()
    const waiting = value.service.wait(handle, { timeoutMs: 250 })

    await vi.advanceTimersByTimeAsync(250)

    await expect(waiting).resolves.toMatchObject({
      outcome: 'timeout',
      status: { workerId: handle.workerId, status: 'running', busy: true }
    })
    expect(value.listeners.size).toBe(0)
  })
})
