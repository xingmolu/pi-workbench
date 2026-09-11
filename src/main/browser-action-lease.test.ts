import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as leases from './browser-action-lease'

afterEach(() => vi.useRealTimers())

describe('browser action ownership', () => {
  it('old completion cannot clear the newer action even with the same request id', () => {
    expect(leases.BrowserActionLeases).toBeDefined()
    const actions = new leases.BrowserActionLeases<object>()
    const page = {}
    const first = actions.begin('agent', 'same', 1, page, 1)
    actions.cancel()
    const second = actions.begin('agent', 'same', 1, page, 1)
    expect(() => actions.assert(first, 1, page, 1)).toThrow('已停止')
    expect(actions.finish(first)).toBe(false)
    expect(actions.current).toBe(second)
    expect(actions.finish(second)).toBe(true)
  })
  it('document, page and project mismatches reject an otherwise live lease', () => {
    expect(leases.BrowserActionLeases).toBeDefined()
    const actions = new leases.BrowserActionLeases<object>()
    const page = {}
    const lease = actions.begin('user', 'one', 1, page, 1)
    for (const args of [
      [2, page, 1],
      [1, {}, 1],
      [1, page, 2]
    ] as const)
      expect(() => actions.assert(lease, args[0], args[1], args[2])).toThrow()
    expect(() => actions.assert(lease, 1, page, 1)).not.toThrow()
  })
  it('delay removes its abort listener and timer after either outcome, repeatedly', async () => {
    expect(leases.waitForDelay).toBeDefined()
    vi.useFakeTimers()
    const controller = new AbortController()
    for (let i = 0; i < 20; i++) {
      const pending = leases.waitForDelay(10, controller.signal)
      await vi.advanceTimersByTimeAsync(10)
      await pending
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
    const pending = leases.waitForDelay(10, controller.signal)
    const rejected = expect(pending).rejects.toThrow('已停止')
    controller.abort()
    await rejected
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
