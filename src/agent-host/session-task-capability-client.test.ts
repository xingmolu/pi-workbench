import { describe, expect, it } from 'vitest'
import { SessionTaskCapabilityClient } from './session-task-capability-client'

const task = {
  taskId: 'task-1',
  parentWorkerId: 'parent-worker',
  parentSessionId: 'parent-session',
  parentGeneration: 3,
  workerId: 'child-worker',
  sessionId: 'child-session',
  generation: 8,
  projectPath: '/project',
  createdAt: 1,
  updatedAt: 2,
  state: 'running' as const,
  busy: true,
  queuedCount: 0,
  approvals: 0
}

function fixture() {
  const sent: unknown[] = []
  let sequence = 0
  const client = new SessionTaskCapabilityClient({
    send: (message) => sent.push(message),
    identity: () => ({ sessionId: 'parent-session', generation: 3 }),
    createRequestId: () => `r${++sequence}`
  })
  return { client, sent }
}

describe('session task capability client', () => {
  it('adds current durable parent identity and accepts a matching delegation response', async () => {
    const { client, sent } = fixture()
    const pending = client.request({ action: 'delegate', tasks: ['inspect'] })

    expect(sent[0]).toEqual({
      type: 'session-task-request',
      requestId: 'r1',
      sessionId: 'parent-session',
      generation: 3,
      action: 'delegate',
      tasks: ['inspect']
    })
    const data = {
      items: [{ index: 0, status: 'spawned' as const, task }],
      spawnedTaskIds: [task.taskId],
      failedIndexes: []
    }
    expect(
      client.accept({
        type: 'session-task-response',
        requestId: 'r1',
        ok: true,
        data
      })
    ).toBe(true)
    await expect(pending).resolves.toEqual(data)
    expect(client.pendingCount).toBe(0)
  })

  it('sends a cancel wire when supervision is aborted', async () => {
    const { client, sent } = fixture()
    const controller = new AbortController()
    const pending = client.request({ action: 'supervise', mode: 'any' }, controller.signal)

    controller.abort()

    await expect(pending).rejects.toThrow('等待后台任务已取消')
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'session-task-request',
        requestId: 'r1',
        action: 'supervise'
      }),
      { type: 'session-task-cancel', requestId: 'r1' }
    ])
  })

  it('reports unknown outcome for an aborted side-effecting request without claiming cancellation', async () => {
    const { client, sent } = fixture()
    const controller = new AbortController()
    const pending = client.request(
      { action: 'delegate', tasks: ['may already run'] },
      controller.signal
    )

    controller.abort()

    await expect(pending).rejects.toThrow('响应未知')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual(expect.objectContaining({ action: 'delegate' }))
  })

  it('cancels collect locally without claiming an unknown side effect', async () => {
    const { client, sent } = fixture()
    const controller = new AbortController()
    const pending = client.request({ action: 'collect' }, controller.signal)

    controller.abort()

    await expect(pending).rejects.toThrow('读取已取消')
    expect(sent).toEqual([
      expect.objectContaining({ type: 'session-task-request', requestId: 'r1', action: 'collect' })
    ])
  })

  it('cancels pending supervision during teardown and rejects other pending operations locally', async () => {
    const { client, sent } = fixture()
    const supervise = client.request({ action: 'supervise', mode: 'all' })
    const collect = client.request({ action: 'collect' })
    const send = client.request({ action: 'send', taskId: task.taskId, prompt: 'follow up' })

    client.rejectAll('runtime closed')
    await expect(supervise).rejects.toThrow('runtime closed')
    await expect(collect).rejects.toThrow('runtime closed')
    await expect(send).rejects.toThrow('runtime closed')
    expect(client.pendingCount).toBe(0)
    expect(sent).toEqual([
      expect.objectContaining({ type: 'session-task-request', requestId: 'r1', action: 'supervise' }),
      expect.objectContaining({ type: 'session-task-request', requestId: 'r2', action: 'collect' }),
      expect.objectContaining({ type: 'session-task-request', requestId: 'r3', action: 'send' }),
      { type: 'session-task-cancel', requestId: 'r1' }
    ])
    expect(
      client.accept({
        type: 'session-task-response',
        requestId: 'r1',
        ok: true,
        data: {
          mode: 'all',
          outcome: 'all-settled',
          tasks: [task],
          settledTaskIds: [task.taskId],
          pendingTaskIds: []
        }
      })
    ).toBe(true)
  })
})
