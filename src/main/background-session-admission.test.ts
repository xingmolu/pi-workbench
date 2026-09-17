import { expect, it, vi } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot, type DesktopEvent, type HostCommand } from '../shared/contracts'
import { SessionWorkerSupervisor } from './session-worker-supervisor'
import type { SessionWorkerFactoryOptions } from './session-worker-pool'

function snapshot(path: string | null): AgentSnapshot {
  return {
    sessionId: path,
    generation: 1,
    revision: 1,
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

function fixture(failStateForPath?: string) {
  const selected = vi.fn()
  const events: DesktopEvent[] = []
  const workers: Array<{
    options: SessionWorkerFactoryOptions
    commands: HostCommand[]
    current: AgentSnapshot
    disposed: boolean
  }> = []
  const supervisor = new SessionWorkerSupervisor({
    canonicalize: async (path) => path,
    publish: (event) => events.push(event),
    selected,
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
            if (worker.current.activeSessionPath === failStateForPath) {
              throw new Error('state unavailable')
            }
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
  return { supervisor, selected, events, workers }
}

it('admits a background session without stealing foreground selection', async () => {
  const { supervisor, selected, events } = fixture()
  const foreground = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  const selection = foreground.desktopScope!
  const snapshotsBefore = events.filter((event) => event.event === 'snapshot').length

  const background = await supervisor.openBackground({ cwd: '/project', path: '/b' })

  expect(supervisor.selectedScope).toEqual(selection)
  expect(supervisor.isSelected(background.workerId)).toBe(false)
  expect(supervisor.findResidentSummary(background.workerId)).toMatchObject({
    workerId: background.workerId,
    sessionPath: '/b',
    selected: false
  })
  expect(selected).toHaveBeenCalledTimes(1)
  expect(events.filter((event) => event.event === 'snapshot')).toHaveLength(snapshotsBefore)
})

it('runs commands in a background resident while preserving the foreground', async () => {
  const { supervisor, workers } = fixture()
  const foreground = await supervisor.open({ cwd: '/project', path: '/a' }, null)
  const background = await supervisor.openBackground({ cwd: '/project', path: '/b' })

  await supervisor.requestWorker(background.workerId, { type: 'prompt:abort' })

  expect(supervisor.selectedScope).toEqual(foreground.desktopScope)
  expect(workers[1].commands.at(-1)?.type).toBe('prompt:abort')
  expect(workers[0].commands.at(-1)?.type).not.toBe('prompt:abort')
})

it('reuses a background resident and can admit one with no foreground at all', async () => {
  const { supervisor, workers, selected } = fixture()
  const first = await supervisor.openBackground({ cwd: '/project', path: '/worker' })
  const second = await supervisor.openBackground({ cwd: '/project', path: '/worker' })

  expect(second.workerId).toBe(first.workerId)
  expect(workers).toHaveLength(1)
  expect(supervisor.selectedScope).toBeNull()
  expect(selected).not.toHaveBeenCalled()
})

it('keeps the foreground intact when background preparation fails', async () => {
  const { supervisor, workers } = fixture('/broken')
  const foreground = await supervisor.open({ cwd: '/project', path: '/a' }, null)

  await expect(
    supervisor.openBackground({ cwd: '/project', path: '/broken' })
  ).rejects.toThrow('state unavailable')

  expect(supervisor.selectedScope).toEqual(foreground.desktopScope)
  expect(workers[1].disposed).toBe(true)
  expect(supervisor.getResidentSummaries().map((summary) => summary.sessionPath)).toEqual(['/a'])
})
