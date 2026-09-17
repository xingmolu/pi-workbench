import { describe, expect, it, vi } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot, type HostCommand, type HostResult } from '../shared/contracts'
import { BackgroundSessionService, type BackgroundSessionRuntime } from './background-session-service'

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

function fixture(childOverrides: Partial<AgentSnapshot> = {}) {
  const residents = new Map<string, AgentSnapshot>()
  residents.set('parent-worker', snapshot())
  const child = snapshot({
    sessionId: 'session-child',
    generation: 8,
    activeSessionPath: null,
    permissionMode: 'ask',
    ...childOverrides
  })
  const commands: Array<{
    workerId: string
    command: HostCommand
    expectedIdentity?: { sessionId: string | null; generation: number }
  }> = []
  const openBackground = vi.fn(async () => {
    residents.set('child-worker', child)
    return { workerId: 'child-worker', snapshot: child }
  })
  const requestWorker = vi.fn(
    async (
      workerId: string,
      command: HostCommand,
      expectedIdentity?: { sessionId: string | null; generation: number }
    ): Promise<HostResult> => {
      commands.push({ workerId, command, expectedIdentity })
      const current = residents.get(workerId)
      if (!current) throw new Error('missing worker')
      if (command.type === 'permission:set') {
        residents.set(workerId, { ...current, permissionMode: command.mode, revision: current.revision + 1 })
      } else if (command.type === 'prompt:send') {
        residents.set(workerId, {
          ...current,
          busy: true,
          status: 'running',
          revision: current.revision + 1
        })
      } else if (command.type === 'prompt:abort') {
        residents.set(workerId, {
          ...current,
          busy: false,
          status: 'stopped',
          revision: current.revision + 1
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
    openBackground,
    requestWorker,
    tryGetSnapshot: (workerId) => residents.get(workerId) ?? null
  }
  return {
    service: new BackgroundSessionService(runtime),
    runtime,
    residents,
    commands,
    openBackground,
    requestWorker
  }
}

describe('background session service', () => {
  it('inherits parent project, model and permission before sending the first task', async () => {
    const { service, openBackground, commands } = fixture()

    const handle = await service.spawnFromParent('parent-worker', '  inspect the failing tests  ')

    expect(openBackground).toHaveBeenCalledWith(
      { cwd: '/project' },
      { providerId: 'provider-a', modelId: 'model-a' }
    )
    expect(commands).toEqual([
      {
        workerId: 'child-worker',
        command: { type: 'permission:set', mode: 'open' },
        expectedIdentity: { sessionId: 'session-child', generation: 8 }
      },
      {
        workerId: 'child-worker',
        command: {
          type: 'prompt:send',
          text: 'inspect the failing tests',
          sessionId: 'session-child',
          generation: 8
        },
        expectedIdentity: { sessionId: 'session-child', generation: 8 }
      }
    ])
    expect(handle).toEqual({
      workerId: 'child-worker',
      sessionId: 'session-child',
      generation: 8,
      projectPath: '/project'
    })
  })

  it('does not write permission state when the child already matches the parent', async () => {
    const { service, commands } = fixture({ permissionMode: 'open' })

    await service.spawnFromParent('parent-worker', 'run tests')

    expect(commands.map(({ command }) => command.type)).toEqual(['prompt:send'])
  })

  it('sends follow-up work and aborts by stable worker identity', async () => {
    const { service, commands } = fixture({ permissionMode: 'open' })
    await service.spawnFromParent('parent-worker', 'first')

    await service.send('child-worker', '  second  ')
    await service.abort('child-worker')

    expect(commands.slice(-2)).toEqual([
      {
        workerId: 'child-worker',
        command: {
          type: 'prompt:send',
          text: 'second',
          sessionId: 'session-child',
          generation: 8
        },
        expectedIdentity: { sessionId: 'session-child', generation: 8 }
      },
      {
        workerId: 'child-worker',
        command: { type: 'prompt:abort' },
        expectedIdentity: { sessionId: 'session-child', generation: 8 }
      }
    ])
  })

  it('returns bounded status instead of exposing the transcript', async () => {
    const { service, residents } = fixture({ permissionMode: 'open' })
    await service.spawnFromParent('parent-worker', 'first')
    const current = residents.get('child-worker')!
    residents.set('child-worker', {
      ...current,
      busy: true,
      status: 'awaiting-approval',
      queuedCount: 2,
      approvals: [
        {
          id: 'approval',
          generation: 8,
          toolCallId: 'tool',
          toolName: 'bash',
          intent: 'terminal',
          title: 'Run',
          detail: 'secret detail'
        }
      ],
      nodes: [{ id: 'private', type: 'assistant', markdown: 'private transcript' }]
    })

    expect(service.status('child-worker')).toEqual({
      workerId: 'child-worker',
      sessionId: 'session-child',
      generation: 8,
      projectPath: '/project',
      status: 'awaiting-approval',
      busy: true,
      queuedCount: 2,
      approvals: 1
    })
    expect(service.status('child-worker')).not.toHaveProperty('nodes')
  })

  it.each([
    ['empty task', () => fixture().service.spawnFromParent('parent-worker', '   '), '不能为空'],
    [
      'missing parent',
      () => fixture().service.spawnFromParent('missing-worker', 'task'),
      '后台会话已结束'
    ],
    [
      'missing model',
      () => {
        const value = fixture()
        value.residents.set('parent-worker', snapshot({ activeProvider: null, activeModel: null }))
        return value.service.spawnFromParent('parent-worker', 'task')
      },
      '没有可继承的模型'
    ],
    [
      'unstable child identity',
      () => fixture({ sessionId: null }).service.spawnFromParent('parent-worker', 'task'),
      '稳定身份'
    ],
    [
      'blocked child',
      () =>
        fixture({ composeBlockReason: 'model-unavailable' }).service.spawnFromParent(
          'parent-worker',
          'task'
        ),
      '不能接收任务'
    ]
  ])('fails closed for %s', async (_name, operation, message) => {
    await expect(operation()).rejects.toThrow(message)
  })
})
