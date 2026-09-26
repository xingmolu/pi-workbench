import { expect, it } from 'vitest'
import {
  AGENT_ENGINE,
  type AgentSnapshot,
  type DesktopEvent,
  type HostCommand,
  type HostResult
} from '../shared/contracts'
import { SessionWorkerController } from './session-worker-controller'
import type { SessionWorkerFactoryOptions } from './session-worker-pool'
import { HostResponseBroker } from './host-response-broker'

function state(sessionId: string, generation = 1): AgentSnapshot {
  return {
    sessionId,
    generation,
    revision: 1,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/agent',
    project: { path: '/project', name: 'project' },
    sessions: [],
    activeSessionPath: null,
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
function fixture(capacity = 8) {
  const events: DesktopEvent[] = []
  const children: {
    options: SessionWorkerFactoryOptions
    state: AgentSnapshot
    commands: HostCommand[]
    pending?: Promise<HostResult>
  }[] = []
  const controller = new SessionWorkerController({
    capacity,
    canonicalize: async (path) => path,
    publish: (event) => events.push(event),
    selected: () => {},
    receiptsSettled: () => true,
    createWorker: async (options) => {
      const child: (typeof children)[number] = {
        options,
        state: state(`session-${children.length}`),
        commands: []
      }
      children.push(child)
      return {
        request: async (command) => {
          child.commands.push(command)
          return child.pending ?? { kind: 'snapshot', snapshot: child.state }
        },
        dispose: async () => {}
      }
    }
  })
  return { controller, events, children }
}
it('keeps a timed-out fork uncertain after an ordinary idle snapshot', async () => {
  const { controller, children } = fixture(2)
  const a = await controller.open({ cwd: '/project' }, null)
  const b = await controller.open({ cwd: '/project' }, a.desktopScope!)
  for (const [index, opened] of [a, b].entries()) {
    children[index].state = { ...opened, activeSessionPath: `/session-${index}`, revision: 2 }
    children[index].options.onEvent({
      type: 'event',
      event: 'snapshot',
      data: children[index].state
    })
  }
  expect(controller.quiescent).toBe(true)
  const broker = new HostResponseBroker({ timeoutMs: 1 })
  const fork: HostCommand = {
    type: 'session:fork',
    sessionId: a.sessionId!,
    generation: a.generation,
    entryId: 'leaf'
  }
  children[0].pending = broker.request(fork, () => {})
  await expect(controller.requestWorker(a.desktopScope!.workerId, fork, { sessionId: a.sessionId, generation: a.generation })).rejects.toThrow('请求超时')
  children[0].pending = undefined
  children[0].options.onEvent({
    type: 'event',
    event: 'snapshot',
    data: { ...children[0].state, revision: 3 }
  })
  expect(controller.quiescent).toBe(false)
  await expect(controller.open({ cwd: '/project' }, b.desktopScope!)).rejects.toThrow(
    '常驻会话已达上限'
  )
  expect(controller.getSnapshot(a.desktopScope!.workerId)?.sessionId).toBe(a.sessionId)
})
it('keeps the worker quiescent after an explicit completed model rejection', async () => {
  const { controller, children } = fixture()
  const a = await controller.open({ cwd: '/project' }, null)
  children[0].options.onEvent({ type: 'event', event: 'snapshot', data: { ...a, revision: 2 } })
  expect(controller.quiescent).toBe(true)
  const command: HostCommand = { type: 'model:set', providerId: 'missing', modelId: 'unavailable' }
  const broker = new HostResponseBroker()
  children[0].pending = broker.request(command, (request) => {
    broker.accept({
      type: 'response',
      requestId: request.requestId,
      ok: false,
      error: '模型不可用'
    })
  })
  await expect(controller.request(command)).rejects.toThrow('模型不可用')
  expect(controller.quiescent).toBe(true)
})
it('keeps a captured A response on A after B selection and hides background A events', async () => {
  const { controller, children, events } = fixture()
  const a = await controller.open({ cwd: '/project' }, null)
  let complete!: (result: HostResult) => void
  children[0].pending = new Promise((resolve) => {
    complete = resolve
  })
  const pending = controller.request(
    { type: 'state:get' },
    { scope: a.desktopScope!, sessionId: a.sessionId, generation: a.generation }
  )
  const b = await controller.open({ cwd: '/project' }, a.desktopScope!)
  events.length = 0
  children[0].options.onEvent({
    type: 'event',
    event: 'snapshot',
    data: { ...a, revision: 2, busy: true, status: 'running' }
  })
  expect(events.every((event) => event.event === 'sessions')).toBe(true)
  complete({ kind: 'snapshot', snapshot: a })
  const result = await pending
  expect(result.kind === 'snapshot' && result.snapshot.desktopScope).toEqual(a.desktopScope)
  expect(controller.selectedScope).toEqual(b.desktopScope)
})
it('rejects stale navigation and same-worker native identity after a fork', async () => {
  const { controller, children } = fixture()
  const a = await controller.open({ cwd: '/project' }, null)
  const origin = { scope: a.desktopScope!, sessionId: a.sessionId, generation: a.generation }
  children[0].options.onEvent({ type: 'event', event: 'snapshot', data: state('fork', 2) })
  await expect(controller.request({ type: 'prompt:abort' }, origin)).rejects.toThrow('会话已改变')
  expect(children[0].commands.some((command) => command.type === 'prompt:abort')).toBe(false)
  const b = await controller.open({ cwd: '/project' }, a.desktopScope!)
  expect(() => controller.select(a.desktopScope!.workerId, origin)).toThrow('Stale selection')
  expect(controller.selectedScope).toEqual(b.desktopScope)
})

it('allows explicit navigation from the last crashed selection without reviving its command authority', async () => {
  const { controller, children } = fixture()
  const a = await controller.open({ cwd: '/project' }, null)
  const b = await controller.open({ cwd: '/project' }, a.desktopScope!)
  const selected = controller.select(a.desktopScope!.workerId)
  const origin = {
    scope: selected.desktopScope!,
    sessionId: selected.sessionId,
    generation: selected.generation
  }
  children[0].options.onExit(new Error('crash'))
  await expect(controller.request({ type: 'prompt:abort' }, origin)).rejects.toThrow(
    'Stale selection'
  )
  expect(controller.select(b.desktopScope!.workerId, origin).sessionId).toBe(b.sessionId)
  expect(() => controller.select(b.desktopScope!.workerId, origin)).toThrow('Stale selection')
})
