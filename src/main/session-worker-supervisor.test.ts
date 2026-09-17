import { expect, it } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot, type HostCommand } from '../shared/contracts'
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
  const workers: Array<{
    options: SessionWorkerFactoryOptions
    commands: HostCommand[]
    current: AgentSnapshot
    disposed: boolean
  }> = []
  const supervisor = new SessionWorkerSupervisor({
    canonicalize: async (path) => path,
    publish: () => {},
    selected: () => {},
    receiptsSettled: () => true,
    createWorker: async (options) => {
      const worker = {
        options,
        commands: [] as HostCommand[],
        current: snapshot(null),
        disposed: false
      }
      workers.push(worker)
      return {
        request: async (command) => {
          worker.commands.push(command)
          if (command.type === 'project:navigate') {
            worker.current = snapshot(command.sessionPath ?? null)
            return { kind: 'snapshot' as const, snapshot: worker.current }
          }
          if (command.type === 'state:get') {
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
  return { supervisor, workers }
}

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
