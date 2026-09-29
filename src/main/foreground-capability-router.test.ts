import { describe, expect, it, vi } from 'vitest'
import { ForegroundCapabilityRouter } from './foreground-capability-router'

function harness() {
  let selected = { workerId: 'a', selectionEpoch: 1 }
  let generation = 1
  const running: Record<string, boolean> = { a: false, b: false }
  const replies = { a: vi.fn(), b: vi.fn() }
  const signals: AbortSignal[] = []
  const completions: Array<(value: unknown) => void> = []
  const executions: string[] = []
  const abort = vi.fn()
  const release = vi.fn()
  const router = new ForegroundCapabilityRouter({
    authority: (owner) => ({
      selected,
      identity: { sessionId: owner, generation },
      running: running[owner]
    }),
    execute: (_request, _owner, id, signal) => {
      signals.push(signal)
      executions.push(id)
      return new Promise((resolve) => completions.push(resolve))
    },
    abortBrowser: abort,
    releaseOwner: release
  })
  const request = (owner: 'a' | 'b', capability = 'computer-use', requestId = 'same') =>
    router.handle(
      owner,
      {
        type: 'capability-request',
        capability,
        requestId,
        sessionId: owner,
        generation,
        operation:
          capability === 'computer-use'
            ? { action: 'observe', mode: 'semantic' }
            : { action: 'tabs' }
      },
      replies[owner]
    )
  return {
    router,
    request,
    replies,
    signals,
    completions,
    executions,
    abort,
    release,
    run: (owner: 'a' | 'b', value: boolean) => {
      running[owner] = value
    },
    select: (workerId: string) => {
      selected = { workerId, selectionEpoch: selected.selectionEpoch + 1 }
      router.invalidate()
    },
    nextGeneration: () => {
      generation++
      router.invalidate()
    },
    silentlyAdvanceGeneration: () => {
      generation++
    }
  }
}

describe('foreground capability lifecycle', () => {
  it('scopes cancellation by owner and capability, and settles immediately', () => {
    const h = harness()
    h.request('a')
    h.request('a', 'browser')
    expect(h.router.pendingCount).toBe(2)
    h.router.handle(
      'b',
      { type: 'capability-cancel', capability: 'computer-use', requestId: 'same' },
      h.replies.b
    )
    h.router.handle(
      'a',
      { type: 'capability-cancel', capability: 'browser', requestId: 'same' },
      h.replies.a
    )
    expect(h.signals[0].aborted).toBe(false)
    h.router.handle(
      'a',
      { type: 'capability-cancel', capability: 'computer-use', requestId: 'same' },
      h.replies.a
    )
    expect(h.signals[0].aborted).toBe(true)
    expect(h.replies.a).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(h.router.pendingCount).toBe(0)
    expect(h.abort).toHaveBeenCalledWith(h.executions[1])
  })

  it.each(['selection', 'generation', 'stop', 'dispose'] as const)(
    'rejects late completion after %s and drains pending work',
    async (reason) => {
      const h = harness()
      // Selection governs the browser; desktop control follows the task (below).
      h.request('a', reason === 'selection' ? 'browser' : 'computer-use')
      if (reason === 'selection') h.select('b')
      if (reason === 'generation') h.nextGeneration()
      if (reason === 'stop') h.router.cancelOwner('a')
      if (reason === 'dispose') {
        h.router.cancelAll()
        h.router.cancelAll()
      }
      expect(h.router.pendingCount).toBe(0)
      expect(h.signals[0].aborted).toBe(true)
      expect(h.release).toHaveBeenCalledWith('a')
      expect(h.release).toHaveBeenCalledTimes(1)
      h.completions[0]('late')
      await Promise.resolve()
      expect(h.replies.a).toHaveBeenCalledTimes(1)
      expect(h.replies.a).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    }
  )

  it('rejects background owners and mismatched native identities at admission', () => {
    const h = harness()
    h.request('b')
    expect(h.executions).toHaveLength(0)
    expect(h.replies.b).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    h.router.handle(
      'a',
      {
        type: 'capability-request',
        capability: 'computer-use',
        requestId: 'old',
        sessionId: 'b',
        generation: 1,
        operation: { action: 'observe' }
      },
      h.replies.a
    )
    expect(h.executions).toHaveLength(0)
    expect(h.router.pendingCount).toBe(0)
  })

  it('revalidates native identity on completion even before a lifecycle notification', async () => {
    const h = harness()
    h.request('a')
    h.silentlyAdvanceGeneration()
    h.completions[0]('stale')
    await Promise.resolve()
    expect(h.replies.a).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(h.router.pendingCount).toBe(0)
    expect(h.release).toHaveBeenCalledWith('a')
  })

  it('old browser cancellation cannot abort a replacement request with the same wire ID', () => {
    const h = harness()
    h.request('a', 'browser')
    h.select('b')
    h.request('b', 'browser')
    h.router.handle(
      'a',
      { type: 'capability-cancel', capability: 'browser', requestId: 'same' },
      h.replies.a
    )
    expect(h.abort).toHaveBeenCalledTimes(1)
    expect(h.abort).toHaveBeenCalledWith(h.executions[0])
    expect(h.signals[1].aborted).toBe(false)
    h.router.cancelAll()
    expect(h.abort).toHaveBeenLastCalledWith(h.executions[1])
    expect(h.router.pendingCount).toBe(0)
  })

  it('isolates replacement execution and captured reply channels', async () => {
    const h = harness()
    h.request('a', 'browser')
    h.select('b')
    h.request('b', 'browser')
    h.completions[0]('old')
    await Promise.resolve()
    expect(h.replies.b).not.toHaveBeenCalled()
    expect(h.executions[0]).not.toBe(h.executions[1])
    h.completions[1]('new')
    await Promise.resolve()
    expect(h.replies.b).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: 'new' }))
    expect(h.router.pendingCount).toBe(0)
  })

  it('lets a running task keep the desktop when the desktop shows another session', async () => {
    const h = harness()
    h.run('b', true)
    // b is not selected (a phone or a background task drives it) but is running.
    h.request('b')
    expect(h.executions).toHaveLength(1)
    h.select('b')
    h.select('a')
    expect(h.signals[0].aborted).toBe(false)
    h.completions[0]('seen')
    await Promise.resolve()
    expect(h.replies.b).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: 'seen' }))
  })

  it('gives the desktop to one task at a time', async () => {
    const h = harness()
    h.run('b', true)
    h.request('b')
    h.completions[0]('done')
    await Promise.resolve()
    h.request('a', 'computer-use', 'second')
    expect(h.executions).toHaveLength(1)
    expect(h.replies.a).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('另一个会话正在控制桌面')
      })
    )
    h.run('b', false)
    h.request('a', 'computer-use', 'third')
    expect(h.executions).toHaveLength(2)
  })

  it('does not hand the desktop to an idle session nobody is looking at', () => {
    const h = harness()
    h.request('b')
    expect(h.executions).toHaveLength(0)
    expect(h.replies.b).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('已切换或已结束') })
    )
  })
})
