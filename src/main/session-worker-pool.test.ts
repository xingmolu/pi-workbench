import { describe, expect, it } from 'vitest'
import {
  AGENT_ENGINE,
  type AgentSnapshot,
  type HostCommand,
  type HostResult
} from '../shared/contracts'
import { SessionWorkerPool, type SessionWorkerFactoryOptions } from './session-worker-pool'
import { diffState } from '../shared/state-patch'
import type { AgentRuntimeDiagnostics } from './agent-runtime'

function snapshot(path: string | null, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    sessionId: path,
    generation: 3,
    revision: 7,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/agent',
    project: { path: '/project', name: 'project' },
    sessions: [],
    activeSessionPath: path,
    nodes: [],
    accounts: [],
    models: [],
    activeProvider: null,
    activeModel: null,
    modelAvailability: 'available',
    composeBlockReason: null,
    busy: false,
    status: 'idle',
    approvals: [],
    followUp: [],
    queuedCount: 0,
    permissionMode: 'ask',
    metrics: { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    login: { phase: 'idle' },
    loginPrompt: null,
    ...overrides
  }
}

function fixture(
  capacity = 8,
  behavior: {
    getDiagnostics?: () => AgentRuntimeDiagnostics
    failPath?: string
    dispose?: () => Promise<void>
    canonicalize?: (path: string) => Promise<string>
  } = {}
) {
  const workers: Array<{
    options: SessionWorkerFactoryOptions
    commands: HostCommand[]
    disposed: boolean
  }> = []
  const pool = new SessionWorkerPool({
    capacity,
    canonicalize: behavior.canonicalize ?? (async (path) => path.replace('/alias/', '/real/')),
    createWorker: async (options) => {
      const worker = { options, commands: [] as HostCommand[], disposed: false }
      workers.push(worker)
      return {
        getDiagnostics: behavior.getDiagnostics,
        request: async (command): Promise<HostResult> => {
          worker.commands.push(command)
          if (
            command.type === 'project:navigate' &&
            command.sessionPath === behavior.failPath &&
            behavior.failPath
          )
            throw new Error('Open failed')
          return command.type === 'project:navigate'
            ? { kind: 'snapshot', snapshot: snapshot(command.sessionPath ?? null) }
            : { kind: 'ack', sessionId: options.workerId, generation: 3, revision: 7 }
        },
        dispose: async () => {
          await behavior.dispose?.()
          worker.disposed = true
        }
      }
    }
  })
  return { pool, workers }
}

describe('session worker ownership', () => {
  it('can select another resident when a background session file was deleted', async () => {
    let missing = false
    const { pool, workers } = fixture(8, {
      canonicalize: async (path) => {
        if (missing && path === '/a') throw Object.assign(new Error('deleted'), { code: 'ENOENT' })
        return path
      }
    })
    const source = await pool.open({ cwd: '/project', path: '/a' })
    const child = await pool.open({ cwd: '/project', path: '/b' }, source.scope)
    pool.select(source.scope.workerId)
    missing = true
    const reopened = await pool.open({ cwd: '/project', path: '/b' })
    expect(reopened.scope.workerId).toBe(child.scope.workerId)
    expect(workers).toHaveLength(2)
    expect(pool.getSnapshot(source.scope.workerId)?.activeSessionPath).toBe('/a')
    await expect(pool.open({ cwd: '/project', path: '/a' })).rejects.toMatchObject({ code: 'ENOENT' })
    await pool.shutdown()
  })
  it('ignores final runtime snapshots emitted during disposal', async () => {
    let options!: SessionWorkerFactoryOptions
    let delivered = 0
    const pool = new SessionWorkerPool({ canonicalize: async path => path,
      onEvent: () => { delivered++; pool.getSnapshot(options.workerId) },
      createWorker: async next => {
        options = next
        return { request: async () => ({ kind: 'snapshot', snapshot: snapshot('/a') }),
          dispose: async () => { options.onEvent({ type: 'event', event: 'snapshot', data: snapshot(null) }) } }
      }
    })
    await pool.open({ cwd: '/project', path: '/a' })
    await expect(pool.shutdown()).resolves.toBeUndefined()
    expect(delivered).toBe(0)
  })
  it('keeps the source selected when target preparation fails', async () => {
    const { pool, workers } = fixture()
    const source = await pool.open({ cwd: '/project', path: '/a' })
    await expect(pool.open({ cwd: '/project' }, source.scope, async () => {
      throw new Error('Model unavailable')
    })).rejects.toThrow('Model unavailable')
    expect(pool.selectedScope).toEqual(source.scope)
    expect(workers[0].disposed).toBe(false)
    expect(workers[1].disposed).toBe(true)
  })
  it('disposes an unused candidate when a resident claims its file during factory startup', async () => {
    let finishFactory!: () => void
    let starting!: () => void
    const started = new Promise<void>((resolve) => {
      starting = resolve
    })
    const workers: SessionWorkerFactoryOptions[] = []
    const commands: HostCommand[][] = []
    const disposed: number[] = []
    const pool = new SessionWorkerPool({
      canonicalize: async (path) => path,
      createWorker: async (options) => {
        const index = workers.length
        workers.push(options)
        commands.push([])
        if (index === 1) {
          starting()
          await new Promise<void>((resolve) => {
            finishFactory = resolve
          })
        }
        return {
          request: async (command) => {
            commands[index].push(command)
            return {
              kind: 'snapshot',
              snapshot: snapshot(
                command.type === 'project:navigate' ? (command.sessionPath ?? null) : null
              )
            }
          },
          dispose: async () => {
            disposed.push(index)
          }
        }
      }
    })
    const a = await pool.open({ cwd: '/project', path: '/a' })
    const opening = pool.open({ cwd: '/project', path: '/fork' })
    await started
    workers[0].onEvent({
      type: 'event',
      event: 'snapshot',
      data: snapshot('/fork', { generation: 4, revision: 1 })
    })
    finishFactory()
    const fork = await opening
    expect(fork.scope.workerId).toBe(a.scope.workerId)
    expect(commands[1]).toEqual([])
    expect(disposed).toEqual([1])
    expect(pool.getLiveSummaries()).toHaveLength(1)
  })

  it.each<HostCommand>([
    { type: 'session:open', path: '/b' },
    { type: 'project:open', cwd: '/other' },
    { type: 'project:navigate', cwd: '/other', sessionId: '/a', generation: 3 }
  ])('rejects public identity-switching commands: %j', async (command) => {
    const { pool, workers } = fixture()
    const a = await pool.open({ cwd: '/project', path: '/a' })
    await expect(pool.request(a.scope, command)).rejects.toThrow('pool.open')
    expect(workers[0].commands).toHaveLength(1)
  })
  it('retries canonical lookup when a resident forks during path resolution', async () => {
    let pause = false
    let resolving!: () => void
    const started = new Promise<void>((resolve) => {
      resolving = resolve
    })
    let finish!: (path: string) => void
    const { pool, workers } = fixture(8, {
      canonicalize: async (path) => {
        if (pause && path === '/a') {
          pause = false
          resolving()
          return new Promise<string>((resolve) => {
            finish = resolve
          })
        }
        return path
      }
    })
    const a = await pool.open({ cwd: '/project', path: '/a' })
    pause = true
    const opening = pool.open({ cwd: '/project', path: '/fork' })
    await started
    workers[0].options.onEvent({
      type: 'event',
      event: 'snapshot',
      data: snapshot('/fork', { generation: 4, revision: 1 })
    })
    finish('/a')
    const fork = await opening
    expect(fork.scope.workerId).toBe(a.scope.workerId)
    expect(workers).toHaveLength(1)
    expect(fork.snapshot.activeSessionPath).toBe('/fork')
  })

  it('returns the latest accepted opening snapshot instead of a delayed older response', async () => {
    const current = snapshot('/a', { revision: 8, busy: true, status: 'running' })
    const pool = new SessionWorkerPool({
      canonicalize: async (path) => path,
      createWorker: async (options) => ({
        request: async () => {
          options.onEvent({ type: 'event', event: 'snapshot', data: current })
          return { kind: 'snapshot', snapshot: snapshot('/a') }
        },
        dispose: async () => {}
      })
    })
    const opened = await pool.open({ cwd: '/project', path: '/a' })
    expect(opened.snapshot).toEqual(current)
  })
  it('keeps the newest transient snapshot when an older event arrives', async () => {
    const { pool, workers } = fixture()
    const a = await pool.open({ cwd: '/project', path: '/a' })
    workers[0].options.onEvent({
      type: 'event',
      event: 'snapshot',
      data: snapshot('/fork', { generation: 4, revision: 1 })
    })
    workers[0].options.onEvent({
      type: 'event',
      event: 'snapshot',
      data: snapshot('/a', { revision: 100 })
    })
    expect(pool.getSnapshot(a.scope.workerId)?.activeSessionPath).toBe('/fork')
    const reopened = await pool.open({ cwd: '/project', path: '/fork' })
    expect(reopened.scope.workerId).toBe(a.scope.workerId)
  })

  it('rejects in-flight requests on owner crash even if the transport never settles', async () => {
    let exit!: (error?: Error) => void
    const pool = new SessionWorkerPool({
      canonicalize: async (p) => p,
      createWorker: async (options) => {
        exit = options.onExit
        return {
          request: async (command) =>
            command.type === 'project:navigate'
              ? { kind: 'snapshot', snapshot: snapshot('/a') }
              : new Promise<HostResult>(() => {}),
          dispose: async () => {}
        }
      }
    })
    const a = await pool.open({ cwd: '/project', path: '/a' })
    const request = pool.request(a.scope, { type: 'prompt:abort' })
    exit(new Error('worker crashed'))
    await expect(request).rejects.toThrow('worker crashed')
  })

  it('shuts down while a new session is waiting for a worker response', async () => {
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    let disposed = false
    const pool = new SessionWorkerPool({
      canonicalize: async (p) => p,
      createWorker: async () => ({
        request: async () => {
          requestStarted()
          return new Promise<HostResult>(() => {})
        },
        dispose: async () => {
          disposed = true
        }
      })
    })
    const opening = pool.open({ cwd: '/project', path: '/a' })
    const rejected = expect(opening).rejects.toThrow('shut down')
    await started
    await pool.shutdown()
    await rejected
    expect(disposed).toBe(true)
    expect(pool.getLiveSummaries()).toEqual([])
  })
  it('rejects canonical file reuse from a different project', async () => {
    const { pool } = fixture()
    const a = await pool.open({ cwd: '/project', path: '/real/a' })
    await expect(pool.open({ cwd: '/other', path: '/alias/a' })).rejects.toThrow('another project')
    expect(pool.selectedScope).toEqual(a.scope)
  })

  it('never admits a worker that exited during factory startup', async () => {
    let disposed = false
    const pool = new SessionWorkerPool({
      canonicalize: async (p) => p,
      createWorker: async (options) => {
        options.onExit(new Error('startup crashed'))
        return {
          request: async () => ({ kind: 'snapshot', snapshot: snapshot('/a') }),
          dispose: async () => {
            disposed = true
          }
        }
      }
    })
    await expect(pool.open({ cwd: '/project', path: '/a' })).rejects.toThrow('startup crashed')
    expect(pool.getLiveSummaries()).toEqual([])
    expect(disposed).toBe(true)
  })
  it('applies transient patches and learns a newly persisted file without serializing nodes', async () => {
    const { pool, workers } = fixture()
    const a = await pool.open({ cwd: '/project' })
    const before = pool.getSnapshot(a.scope.workerId)!
    const after = {
      ...before,
      revision: 8,
      activeSessionPath: '/real/new',
      nodes: [{ id: '1', type: 'user' as const, text: 'private transcript' }]
    }
    workers[0].options.onEvent({ type: 'event', event: 'patch', data: diffState(before, after) })
    expect(pool.getSnapshot(a.scope.workerId)).toEqual(after)
    const reopened = await pool.open({ cwd: '/project', path: '/alias/new' })
    expect(reopened.scope.workerId).toBe(a.scope.workerId)
    expect(pool.getLiveSummaries()[0].title).toBe('private transcript')
    expect(pool.getLiveSummaries()[0]).not.toHaveProperty('nodes')
  })

  it('isolates a worker crash and rejects commands captured for its dead owner', async () => {
    const { pool, workers } = fixture()
    const a = await pool.open({ cwd: '/project', path: '/a' })
    const b = await pool.open({ cwd: '/project', path: '/b' })
    workers[0].options.onExit(new Error('crashed'))
    await expect(pool.request(a.scope, { type: 'prompt:abort' })).rejects.toThrow(
      'no longer resident'
    )
    await expect(pool.request(b.scope, { type: 'prompt:abort' })).resolves.toMatchObject({
      kind: 'ack'
    })
    expect(pool.selectedScope).toEqual(b.scope)
    await pool.shutdown()
    expect(workers[1].disposed).toBe(true)
    expect(pool.getLiveSummaries()).toEqual([])
    await expect(pool.open({ cwd: '/project', path: '/c' })).rejects.toThrow('shut down')
  })
  it('limits residents to eight and awaits safe eviction before admitting a replacement', async () => {
    let finishDispose!: () => void
    const { pool, workers } = fixture(8, {
      dispose: () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve
        })
    })
    for (let i = 0; i < 8; i++) {
      const opened = await pool.open({ cwd: '/project', path: `/${i}` })
      pool.updateSafety(opened.scope.workerId, { receipts: 'settled', unsaved: false })
    }
    const replacement = pool.open({ cwd: '/project', path: '/replacement' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(workers).toHaveLength(8)
    expect(finishDispose).toBeTypeOf('function')
    finishDispose()
    await replacement
    expect(workers[0].disposed).toBe(true)
    expect(pool.getLiveSummaries()).toHaveLength(8)
  })

  it.each([
    { busy: true },
    { queuedCount: 1 },
    { followUp: ['queued'] },
    { approvals: [{}] },
    { login: { phase: 'starting', providerId: 'p' } },
    { edit: { entryId: null, leafId: null, reason: null, pending: true } },
    { activeSessionPath: null },
    { ready: false }
  ] as Partial<AgentSnapshot>[])(
    'refuses eviction when a resident is unsafe: %j',
    async (unsafe) => {
      const { pool, workers } = fixture(2)
      const a = await pool.open({ cwd: '/project', path: '/a' })
      pool.updateSafety(a.scope.workerId, { receipts: 'settled', unsaved: false })
      workers[0].options.onEvent({ type: 'event', event: 'snapshot', data: snapshot('/a', unsafe) })
      await pool.open({ cwd: '/project', path: '/b' })
      await expect(pool.open({ cwd: '/project', path: '/c' })).rejects.toThrow('常驻会话已达上限')
      expect(workers).toHaveLength(2)
    }
  )

  it('protects selected, unknown receipt, and unsaved residents', async () => {
    const { pool } = fixture(2)
    const a = await pool.open({ cwd: '/project', path: '/a' })
    const b = await pool.open({ cwd: '/project', path: '/b' })
    pool.updateSafety(b.scope.workerId, { receipts: 'settled', unsaved: false })
    await expect(pool.open({ cwd: '/project', path: '/c' })).rejects.toThrow('常驻会话已达上限')
    pool.updateSafety(a.scope.workerId, { receipts: 'settled', unsaved: true })
    await expect(pool.open({ cwd: '/project', path: '/c' })).rejects.toThrow('常驻会话已达上限')
    expect(pool.selectedScope).toEqual(b.scope)
  })
  it('preserves the selected source and cleans up a failed replacement', async () => {
    const { pool, workers } = fixture(8, { failPath: '/bad' })
    const a = await pool.open({ cwd: '/project', path: '/a' })
    await expect(pool.open({ cwd: '/project', path: '/bad' })).rejects.toThrow('Open failed')
    expect(pool.selectedScope).toEqual(a.scope)
    expect(pool.getLiveSummaries()).toHaveLength(1)
    expect(workers[1].disposed).toBe(true)
  })
  it('serializes duplicate canonical opens and reuses the resident', async () => {
    const { pool, workers } = fixture()
    const [a, b] = await Promise.all([
      pool.open({ cwd: '/project', path: '/alias/a' }),
      pool.open({ cwd: '/project', path: '/real/a' })
    ])
    expect(a.scope.workerId).toBe(b.scope.workerId)
    expect(workers).toHaveLength(1)
    expect(b.scope.selectionEpoch).toBeGreaterThan(a.scope.selectionEpoch)
  })
  it('keeps two residents alive and routes captured commands to their original owner', async () => {
    const { pool, workers } = fixture()
    const a = await pool.open({ cwd: '/project', path: '/a' })
    const b = await pool.open({ cwd: '/project', path: '/b' })
    await pool.request(a.scope, { type: 'prompt:abort' })
    expect(workers[0].commands.at(-1)).toEqual({ type: 'prompt:abort' })
    expect(workers[1].commands).toEqual([
      {
        type: 'project:navigate',
        cwd: '/project',
        sessionPath: '/b',
        sessionId: null,
        generation: 0
      }
    ])
    expect(pool.getLiveSummaries()).toHaveLength(2)
    expect(b.scope.selectionEpoch).toBeGreaterThan(a.scope.selectionEpoch)
    expect(() => pool.validateSelected(a.scope)).toThrow('Stale selection')
    expect(pool.getSnapshot(a.scope.workerId)?.generation).toBe(3)
  })
})


it('projects runtime counts and identity without session content, including disposal until exit', async () => {
  let release!: () => void
  const disposal = new Promise<void>(resolve => { release = resolve })
  const { pool } = fixture(8, {
    dispose: () => disposal,
    getDiagnostics: () => ({ pid: 123, pendingRequests: 2, disposing: false, exited: false })
  })
  const opened = await pool.open({ cwd: '/private/project', path: '/private/session' })
  const before = pool.getDiagnostics()
  expect(before).toEqual({
    selectedWorkerId: opened.scope.workerId,
    residentSessions: 1,
    workers: [{ workerId: opened.scope.workerId, pid: 123, sessionId: '/private/session',
      generation: 3, status: 'idle', busy: false, residentPendingRequests: 0,
      runtimePendingRequests: 2, disposing: false, exited: false }]
  })
  const shutdown = pool.shutdown()
  expect(pool.getDiagnostics().workers[0].disposing).toBe(true)
  expect(pool.getDiagnostics().residentSessions).toBe(1)
  expect(before.workers[0].disposing).toBe(false)
  release()
  await shutdown
  expect(pool.getDiagnostics().residentSessions).toBe(0)
})

it('does not count crash summaries as resident processes and supports runtimes without diagnostics', async () => {
  const { pool, workers } = fixture()
  await pool.open({ cwd: '/project', path: '/session' })
  expect(pool.getDiagnostics().workers[0]).toMatchObject({ pid: null, runtimePendingRequests: null, exited: null })
  workers[0].options.onExit(new Error('crash'))
  expect(pool.getLiveSummaries()).toHaveLength(1)
  expect(pool.getDiagnostics().workers).toEqual([])
  expect(pool.getDiagnostics().residentSessions).toBe(0)
})
