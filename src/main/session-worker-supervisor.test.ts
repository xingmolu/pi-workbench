import { expect, it } from 'vitest'
import {
  AGENT_ENGINE,
  type AgentSnapshot,
  type DesktopEvent,
  type HostCommand
} from '../shared/contracts'
import { SessionWorkerController } from './session-worker-controller'
import { SessionWorkerSupervisor } from './session-worker-supervisor'
import type { SessionWorkerFactoryOptions } from './session-worker-pool'

function snapshot(path: string | null, revision = 1): AgentSnapshot {
  return {
    sessionId: path,
    generation: 1,
    revision,
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
    loginPrompt: null
  }
}

function fixture() {
  const published: DesktopEvent[] = []
  const workers: Array<{
    options: SessionWorkerFactoryOptions
    commands: HostCommand[]
    identities: Array<{ sessionId: string | null; generation: number } | undefined>
    stateBarrier?: Promise<void>
    stateRequested?: () => void
    current: AgentSnapshot
    disposed: boolean
  }> = []
  const resyncs: Promise<void>[] = []
  const supervisor = new SessionWorkerSupervisor({
    onNeedsSnapshot: (workerId) => {
      resyncs.push(supervisor.resyncWorker(workerId))
    },
    canonicalize: async (path) => path,
    publish: (event) => {
      published.push(event)
    },
    selected: () => {},
    receiptsSettled: () => true,
    createWorker: async (options) => {
      const worker: (typeof workers)[number] = {
        options,
        commands: [],
        identities: [],
        current: snapshot(null),
        disposed: false
      }
      workers.push(worker)
      return {
        request: async (command, identity) => {
          worker.commands.push(command)
          worker.identities.push(identity)
          if (command.type === 'project:navigate') {
            worker.current = snapshot(command.sessionPath ?? null)
            return { kind: 'snapshot' as const, snapshot: worker.current }
          }
          if (command.type === 'state:get') {
            const barrier = worker.stateBarrier
            worker.stateRequested?.()
            await barrier
            return { kind: 'snapshot' as const, snapshot: worker.current }
          }
          return {
            kind: 'ack' as const,
            sessionId: worker.current.sessionId,
            generation: worker.current.generation,
            revision: worker.current.revision
          }
        },
        dispose: async () => {
          worker.disposed = true
        }
      }
    }
  })
  return { supervisor, workers, published, resyncs }
}

it('publishes every transcript patch but only changed sidebar projections during streaming', async () => {
  const { supervisor, workers, published } = fixture()
  await supervisor.open({ cwd: '/project', path: '/a' }, null)
  published.length = 0
  let lifecycleUpdates = 0
  const unsubscribe = supervisor.subscribe(() => {
    lifecycleUpdates++
  })
  let revision = 1
  const patch = (meta = {}) =>
    workers[0].options.onEvent({
      type: 'event',
      event: 'patch',
      data: {
        sessionId: '/a',
        generation: 1,
        baseRevision: revision,
        revision: ++revision,
        nodeUpserts: [
          { id: 'answer', type: 'assistant', markdown: `Reply ${revision}`, streaming: true }
        ],
        removedNodeIds: [],
        meta
      }
    })
  for (let i = 0; i < 100; i++) patch()
  expect(published.filter((event) => event.event === 'patch')).toHaveLength(100)
  expect(lifecycleUpdates).toBe(100)
  expect(published.filter((event) => event.event === 'sessions')).toHaveLength(0)

  patch({ status: 'awaiting-approval' })
  expect(published.filter((event) => event.event === 'sessions')).toHaveLength(1)
  patch({
    sessions: [
      {
        id: '/a',
        path: '/a',
        title: 'Renamed',
        modified: '',
        messageCount: 1,
        active: true,
        status: 'awaiting-approval'
      }
    ]
  })
  expect(published.filter((event) => event.event === 'sessions')).toHaveLength(2)
  patch({ status: 'idle' })
  expect(published.filter((event) => event.event === 'sessions')).toHaveLength(3)

  // Explicit replay must still initialize a new renderer even if nothing changed.
  supervisor.summaries()
  expect(published.filter((event) => event.event === 'sessions')).toHaveLength(4)
  supervisor.clearSelection(supervisor.selectedScope)
  expect(published.at(-1)).toMatchObject({ event: 'sessions', data: [{ selected: false }] })
  unsubscribe()
  await supervisor.shutdown()
})

it('keeps the old controller name as a compatibility alias', () => {
  expect(SessionWorkerController).toBe(SessionWorkerSupervisor)
})

it('routes background worker commands without changing foreground selection', async () => {
  const { supervisor, workers } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  const b = await supervisor.open({ cwd: '/project', path: '/b' }, a.desktopScope!)

  expect(supervisor.selectedScope).toEqual(b.desktopScope)
  await supervisor.requestWorker(a.desktopScope!.workerId, { type: 'prompt:abort' })
  expect(supervisor.selectedScope).toEqual(b.desktopScope)
  expect(workers[0].commands.at(-1)?.type).toBe('prompt:abort')
  expect(workers[1].commands.at(-1)?.type).not.toBe('prompt:abort')

  await supervisor.request({ type: 'prompt:abort' })
  expect(workers[1].commands.at(-1)?.type).toBe('prompt:abort')
  await supervisor.shutdown()
  expect(workers.every((worker) => worker.disposed)).toBe(true)
})

it('exposes runtime state without requiring callers to reach through the pool', async () => {
  const { supervisor } = fixture()
  const opened = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  const workerId = opened.desktopScope!.workerId

  expect(supervisor.getSnapshot(workerId)?.sessionId).toBe('/a')
  expect(supervisor.tryGetSnapshot(workerId)?.sessionId).toBe('/a')
  expect(supervisor.findLiveSummary(workerId)?.sessionPath).toBe('/a')
  expect(supervisor.findResidentSummary(workerId)?.sessionPath).toBe('/a')
  expect(supervisor.getResidentSummaries()).toHaveLength(1)
  expect(supervisor.hasSelection).toBe(true)
  expect(supervisor.isSelected(workerId)).toBe(true)
  expect(supervisor.retainsSelection(opened.desktopScope!)).toBe(true)
  supervisor.updateSafety(workerId, { receipts: 'settled', unsaved: false })
  expect(supervisor.quiescent).toBe(true)
  supervisor.validateSelected(supervisor.selectedScope)
})

it('separates resident workers from crash tombstones and stale selections', async () => {
  const { supervisor, workers } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  const b = await supervisor.open({ cwd: '/project', path: '/b' }, a.desktopScope!)
  const aId = a.desktopScope!.workerId
  const bId = b.desktopScope!.workerId

  expect(supervisor.retainsSelection(a.desktopScope!)).toBe(false)
  expect(supervisor.retainsSelection(b.desktopScope!)).toBe(true)
  expect(supervisor.isSelected(aId)).toBe(false)
  expect(supervisor.isSelected(bId)).toBe(true)
  expect(supervisor.getResidentSummaries().map((item) => item.workerId)).toEqual([aId, bId])

  workers[0].options.onExit(new Error('worker crashed'))

  expect(supervisor.tryGetSnapshot(aId)).toBeNull()
  expect(supervisor.findResidentSummary(aId)).toBeUndefined()
  expect(supervisor.findLiveSummary(aId)).toMatchObject({ workerId: aId, status: 'error' })
  expect(supervisor.getResidentSummaries().map((item) => item.workerId)).toEqual([bId])
  expect(supervisor.retainsSelection(b.desktopScope!)).toBe(true)
})

it('publishes background lifecycle snapshots and an exit tombstone without stealing selection', async () => {
  const { supervisor, workers } = fixture()
  const events: Array<{ workerId: string; snapshot: AgentSnapshot | null }> = []
  const unsubscribe = supervisor.subscribe((workerId, current) => {
    events.push({ workerId, snapshot: current })
  })

  const admitted = await supervisor.openBackground({ cwd: '/project', path: '/background' })
  expect(supervisor.selectedScope).toBeNull()
  expect(events.at(-1)).toMatchObject({
    workerId: admitted.workerId,
    snapshot: { sessionId: '/background', revision: 1 }
  })

  workers[0].options.onEvent({
    type: 'event',
    event: 'snapshot',
    data: snapshot('/background', 2)
  })
  expect(events.at(-1)).toMatchObject({
    workerId: admitted.workerId,
    snapshot: { revision: 2 }
  })

  workers[0].options.onExit(new Error('worker crashed'))
  expect(events.at(-1)).toEqual({ workerId: admitted.workerId, snapshot: null })

  const count = events.length
  unsubscribe()
  expect(events).toHaveLength(count)
})

it('detaches an idle foreground with a monotonic epoch without stopping or deleting residents', async () => {
  const { supervisor, workers } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  supervisor.updateSafety(a.desktopScope!.workerId, { receipts: 'settled', unsaved: false })
  expect(supervisor.navigationMutationReason('/project')).toBeNull()
  const epoch = supervisor.clearSelection(a.desktopScope!)
  expect(epoch).toBeGreaterThan(a.desktopScope!.selectionEpoch)
  expect(supervisor.selectedScope).toBeNull()
  expect(workers[0].disposed).toBe(false)
  expect(supervisor.getLiveSummaries()).toHaveLength(1)
  expect(() => supervisor.clearSelection(a.desktopScope!)).toThrow()
  const b = await supervisor.open({ cwd: '/project', path: '/b' }, null)
  expect(b.desktopScope!.selectionEpoch).toBeGreaterThan(epoch)
  await supervisor.shutdown()
})

it('recovers a background patch gap without publishing it as the foreground', async () => {
  const { supervisor, workers, published, resyncs } = fixture()
  const background = await supervisor.openBackground({ cwd: '/project', path: '/background' })
  const foreground = await supervisor.open({ cwd: '/project', path: '/foreground' }, null)
  const updates: Array<AgentSnapshot | null> = []
  supervisor.subscribe((workerId, state) => {
    if (workerId === background.workerId) updates.push(state)
  })
  workers[0].current = { ...snapshot('/background', 4), busy: true, status: 'running' }
  published.length = 0
  workers[0].options.onEvent({
    type: 'event',
    event: 'patch',
    data: {
      sessionId: '/background',
      generation: 1,
      baseRevision: 3,
      revision: 4,
      nodeUpserts: [],
      removedNodeIds: [],
      meta: {}
    }
  })
  await Promise.all(resyncs)
  expect(resyncs).toHaveLength(1)
  expect(workers[0].identities.at(-1)).toEqual({ sessionId: '/background', generation: 1 })
  expect(supervisor.getSnapshot(background.workerId)?.revision).toBe(4)
  expect(updates.at(-1)?.revision).toBe(4)
  expect(supervisor.selectedScope).toEqual(foreground.desktopScope)
  expect(published.every((event) => event.event === 'sessions')).toBe(true)
  expect(supervisor.findLiveSummary(background.workerId)?.status).toBe('running')
  await supervisor.shutdown()
})

it('finishes a foreground resync after selection changes without projecting the old worker', async () => {
  const { supervisor, workers, published } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  const b = await supervisor.openBackground({ cwd: '/project', path: '/b' })
  let release!: () => void
  workers[0].stateBarrier = new Promise((resolve) => {
    release = resolve
  })
  workers[0].current = snapshot('/a', 3)
  const resync = supervisor.resyncWorker(a.desktopScope!.workerId)
  const selected = supervisor.select(b.workerId)
  published.length = 0
  release()
  await resync
  expect(supervisor.selectedScope).toEqual(selected.desktopScope)
  expect(supervisor.getSnapshot(a.desktopScope!.workerId)?.revision).toBe(3)
  expect(published.every((event) => event.event === 'sessions')).toBe(true)
  await supervisor.shutdown()
})

it('projects a recovered foreground snapshot with its exact selection epoch', async () => {
  const { supervisor, workers, published } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  workers[0].current = snapshot('/a', 3)
  published.length = 0
  await supervisor.resyncWorker(a.desktopScope!.workerId)
  expect(published.find((event) => event.event === 'snapshot')).toMatchObject({
    data: { revision: 3, desktopScope: a.desktopScope }
  })
  expect(supervisor.selectedScope).toEqual(a.desktopScope)
  await supervisor.shutdown()
})

it.each(['background', 'reselected'] as const)(
  'keeps a %s resync from gaining a new foreground epoch',
  async (selection) => {
    const { supervisor, workers, published } = fixture()
    const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
    const b = await supervisor.openBackground({ cwd: '/project', path: '/b' })
    if (selection === 'background') supervisor.select(b.workerId)
    const updates: Array<AgentSnapshot | null> = []
    supervisor.subscribe((workerId, state) => {
      if (workerId === a.desktopScope!.workerId) updates.push(state)
    })
    let release!: () => void
    workers[0].stateBarrier = new Promise((resolve) => {
      release = resolve
    })
    workers[0].current = { ...snapshot('/a', 3), busy: true, status: 'running' }
    const resync = supervisor.resyncWorker(a.desktopScope!.workerId)
    if (selection === 'reselected') supervisor.select(b.workerId)
    const selected = supervisor.select(a.desktopScope!.workerId)
    expect(selected.desktopScope!.selectionEpoch).toBeGreaterThan(a.desktopScope!.selectionEpoch)
    published.length = 0
    release()
    await resync
    expect(supervisor.selectedScope).toEqual(selected.desktopScope)
    expect(supervisor.getSnapshot(a.desktopScope!.workerId)?.revision).toBe(3)
    expect(updates.at(-1)?.revision).toBe(3)
    // The original response only updates summaries. Explicit reselection owns a fresh trailing request.
    expect(published.filter((event) => event.event === 'snapshot')).toHaveLength(1)
    expect(published[0]).toMatchObject({
      event: 'sessions',
      data: expect.arrayContaining([
        expect.objectContaining({
          workerId: a.desktopScope!.workerId,
          selected: true,
          status: 'running'
        })
      ])
    })
    await supervisor.shutdown()
  }
)

it('coalesces 1000 recovery requests into one in-flight request and one trailing recovery', async () => {
  const { supervisor, workers } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  let release!: () => void
  workers[0].stateBarrier = new Promise((resolve) => {
    release = resolve
  })
  workers[0].commands.length = 0
  const recovery = supervisor.resyncWorker(a.desktopScope!.workerId)
  const burst = Array.from({ length: 1000 }, () =>
    supervisor.resyncWorker(a.desktopScope!.workerId)
  )
  expect(workers[0].commands).toHaveLength(1)
  workers[0].current = snapshot('/a', 10)
  release()
  await Promise.all([recovery, ...burst])
  expect(workers[0].commands).toHaveLength(2)
  expect(supervisor.getSnapshot(a.desktopScope!.workerId)?.revision).toBe(10)
  await supervisor.shutdown()
})

it.each([false, true])(
  'fences a new selection-owned trailing recovery when switched again: %s',
  async (switchAgain) => {
    const { supervisor, workers, published } = fixture()
    const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
    const b = await supervisor.openBackground({ cwd: '/project', path: '/b' })
    let releaseFirst!: () => void
    let releaseTrailing!: () => void
    workers[0].stateBarrier = new Promise((resolve) => {
      releaseFirst = resolve
    })
    workers[0].stateRequested = () => {
      workers[0].stateBarrier = new Promise((resolve) => {
        releaseTrailing = resolve
      })
      workers[0].stateRequested = undefined
    }
    const recovery = supervisor.resyncWorker(a.desktopScope!.workerId)
    supervisor.select(b.workerId)
    const selected = supervisor.select(a.desktopScope!.workerId)
    published.length = 0
    workers[0].current = snapshot('/a', 4)
    releaseFirst()
    // Observe the original response while the selection-owned request remains pending.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(published.every((event) => event.event === 'sessions')).toBe(true)
    workers[0].current = snapshot('/a', 5)
    if (switchAgain) {
      supervisor.select(b.workerId)
      published.length = 0
    }
    releaseTrailing()
    await recovery
    expect(published.filter((event) => event.event === 'snapshot')).toEqual(
      switchAgain
        ? []
        : [
            expect.objectContaining({
              data: expect.objectContaining({ revision: 5, desktopScope: selected.desktopScope })
            })
          ]
    )
    await supervisor.shutdown()
  }
)

it('cleans up failed recovery without automatic retries and allows a later external retry', async () => {
  const { supervisor, workers } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  let reject!: (error: Error) => void
  workers[0].stateBarrier = new Promise((_, fail) => {
    reject = fail
  })
  workers[0].commands.length = 0
  const first = supervisor.resyncWorker(a.desktopScope!.workerId)
  const burst = supervisor.resyncWorker(a.desktopScope!.workerId)
  reject(new Error('unavailable'))
  await expect(first).rejects.toThrow('unavailable')
  await expect(burst).rejects.toThrow('unavailable')
  expect(workers[0].commands).toHaveLength(1)
  workers[0].stateBarrier = undefined
  await supervisor.resyncWorker(a.desktopScope!.workerId)
  expect(workers[0].commands).toHaveLength(2)
  await supervisor.shutdown()
})

it('keeps the newest accepted generation when a captured recovery returns older native state', async () => {
  const { supervisor, workers } = fixture()
  const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  let release!: () => void
  workers[0].stateBarrier = new Promise((resolve) => {
    release = resolve
  })
  const recovery = supervisor.resyncWorker(a.desktopScope!.workerId)
  workers[0].options.onEvent({
    type: 'event',
    event: 'snapshot',
    data: { ...snapshot('/a', 2), generation: 2 }
  })
  release()
  await recovery
  expect(workers[0].identities.at(-1)).toEqual({ sessionId: '/a', generation: 1 })
  expect(supervisor.getSnapshot(a.desktopScope!.workerId)).toMatchObject({
    generation: 2,
    revision: 2
  })
  await supervisor.shutdown()
})

it.each(['exit', 'shutdown'] as const)(
  'drops pending trailing recovery on worker %s',
  async (ending) => {
    const { supervisor, workers, published } = fixture()
    const a = await supervisor.open({ cwd: '/project', path: '/a' }, null)
    let release!: () => void
    workers[0].stateBarrier = new Promise((resolve) => {
      release = resolve
    })
    workers[0].commands.length = 0
    const recovery = supervisor.resyncWorker(a.desktopScope!.workerId)
    const result = recovery.catch(() => undefined)
    supervisor.resyncWorker(a.desktopScope!.workerId).catch(() => undefined)
    if (ending === 'exit') workers[0].options.onExit(new Error('exited'))
    else await supervisor.shutdown()
    published.length = 0
    release()
    await result
    expect(workers[0].commands).toHaveLength(1)
    expect(published).toHaveLength(0)
    await supervisor.shutdown()
  }
)
