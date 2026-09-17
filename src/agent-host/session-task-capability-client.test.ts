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
  it('adds current durable parent identity and accepts a matching response', async () => {
    const { client, sent } = fixture()
    const pending = client.request({ action: 'spawn', prompt: 'inspect' })

    expect(sent[0]).toEqual({
      type: 'session-task-request',
      requestId: 'r1',
      sessionId: 'parent-session',
      generation: 3,
      action: 'spawn',
      prompt: 'inspect'
    })
    expect(client.accept({
      type: 'session-task-response',
      requestId: 'r1',
      ok: true,
      data: task
    })).toBe(true)
    await expect(pending).resolves.toEqual(task)
    expect(client.pendingCount).toBe(0)
  })

  it.each([
    [{ action: 'wait' as const, taskId: 'task-1' }, 'wait'],
    [{ action: 'supervise' as const, mode: 'any' as const }, 'supervise']
  ])('sends a cancel wire for cancellable %s aborts', async (operation, action) => {
    const { client, sent } = fixture()
    const controller = new AbortController()
    const pending = client.request(operation, controller.signal)

    controller.abort()

    await expect(pending).rejects.toThrow('等待后台任务已取消')
    expect(sent).toEqual([
      expect.objectContaining({ type: 'session-task-request', requestId: 'r1', action }),
      { type: 'session-task-cancel', requestId: 'r1' }
    ])
  })

  it('reports unknown outcome for an aborted side-effecting request without claiming cancellation', async () => {
    const { client, sent } = fixture()
    const controller = new AbortController()
    const pending = client.request(
      { action: 'spawn', prompt: 'may already run' },
      controller.signal
    )

    controller.abort()

    await expect(pending).rejects.toThrow('响应未知')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual(expect.objectContaining({ action: 'spawn' }))
  })

  it.each([
    [{ action: 'status' as const, taskId: 'task-1' }, 'status'],
    [{ action: 'list' as const }, 'list'],
    [{ action: 'result' as const, taskId: 'task-1' }, 'result'],
    [{ action: 'collect' as const }, 'collect']
  ])('cancels pure read %s locally without claiming an unknown side effect', async (operation, action) => {
    const { client, sent } = fixture()
    const controller = new AbortController()
    const pending = client.request(operation, controller.signal)

    controller.abort()

    await expect(pending).rejects.toThrow('读取已取消')
    expect(sent).toEqual([
      expect.objectContaining({ type: 'session-task-request', requestId: 'r1', action })
    ])
  })

  it('cancels pending waits and supervision during runtime teardown and ignores late responses', async () => {
    const { client, sent } = fixture()
    const wait = client.request({ action: 'wait', taskId: 'task-1' })
    const supervise = client.request({ action: 'supervise', mode: 'all' })
    const status = client.request({ action: 'status', taskId: 'task-1' })

    client.rejectAll('runtime closed')
    await expect(wait).rejects.toThrow('runtime closed')
    await expect(supervise).rejects.toThrow('runtime closed')
    await expect(status).rejects.toThrow('runtime closed')
    expect(client.pendingCount).toBe(0)
    expect(sent).toEqual([
      expect.objectContaining({ type: 'session-task-request', requestId: 'r1', action: 'wait' }),
      expect.objectContaining({ type: 'session-task-request', requestId: 'r2', action: 'supervise' }),
      expect.objectContaining({ type: 'session-task-request', requestId: 'r3', action: 'status' }),
      { type: 'session-task-cancel', requestId: 'r1' },
      { type: 'session-task-cancel', requestId: 'r2' }
    ])
    expect(
      client.accept({
        type: 'session-task-response',
        requestId: 'r1',
        ok: true,
        data: task
      })
    ).toBe(true)
  })
})
