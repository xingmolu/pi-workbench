import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../shared/contracts'
import {
  ApprovalRegistry,
  type ApprovalRegistryChange,
  APPROVAL_TIMEOUT_MS
} from './approval-registry'

function request(id: string, generation = 7): ApprovalRequest {
  return {
    id,
    generation,
    toolCallId: `tool-${id}`,
    toolName: 'bash',
    intent: 'terminal',
    title: `Run ${id}`,
    detail: `command ${id}`
  }
}

describe('ApprovalRegistry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tracks and resolves concurrent approvals independently', async () => {
    const changes: ApprovalRegistryChange[] = []
    const registry = new ApprovalRegistry((change) => changes.push(change))
    const firstRequest = request('first')
    const secondRequest = request('second')

    const first = registry.request(firstRequest)
    const second = registry.request(secondRequest)

    expect(registry.requests(7)).toEqual([firstRequest, secondRequest])
    expect(registry.resolve('first', 7, true)).toBe(true)
    expect(await first).toBe(true)
    expect(registry.requests(7)).toEqual([secondRequest])
    expect(registry.resolve('second', 7, false)).toBe(true)
    expect(await second).toBe(false)
    expect(changes.map(({ status }) => status)).toEqual([
      'pending',
      'pending',
      'allowed',
      'blocked'
    ])
  })

  it('blocks an unanswered approval at exactly five minutes', async () => {
    const changes: ApprovalRegistryChange[] = []
    const registry = new ApprovalRegistry((change) => changes.push(change))
    const pending = registry.request(request('timeout'))

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1)
    expect(registry.requests(7)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
    expect(registry.requests(7)).toEqual([])
    expect(registry.resolve('timeout', 7, true)).toBe(false)
    expect(changes.at(-1)).toEqual({
      status: 'blocked',
      request: request('timeout'),
      reason: 'timeout'
    })
  })

  it('blocks and removes an approval when its operation aborts', async () => {
    const changes: ApprovalRegistryChange[] = []
    const registry = new ApprovalRegistry((change) => changes.push(change))
    const controller = new AbortController()
    const pending = registry.request(request('aborted'), controller.signal)

    controller.abort()

    await expect(pending).resolves.toBe(false)
    expect(registry.requests(7)).toEqual([])
    expect(changes.at(-1)).toEqual({
      status: 'blocked',
      request: request('aborted'),
      reason: 'abort'
    })
  })

  it('cleans only the switched generation and rejects stale responses safely', async () => {
    const changes: ApprovalRegistryChange[] = []
    const registry = new ApprovalRegistry((change) => changes.push(change))
    const oldFirst = registry.request(request('old-first', 7))
    const oldSecond = registry.request(request('old-second', 7))
    const currentRequest = request('current', 8)
    const current = registry.request(currentRequest)

    expect(registry.clear(7, 'session-switch')).toBe(2)
    await expect(oldFirst).resolves.toBe(false)
    await expect(oldSecond).resolves.toBe(false)
    expect(registry.requests(7)).toEqual([])
    expect(registry.requests(8)).toEqual([currentRequest])
    expect(registry.resolve('old-first', 7, true)).toBe(false)
    expect(registry.resolve('current', 7, true)).toBe(false)
    expect(registry.requests(8)).toEqual([currentRequest])

    expect(registry.resolve('current', 8, true)).toBe(true)
    await expect(current).resolves.toBe(true)
    expect(
      changes.filter((change) => change.status === 'blocked').map((change) => change.reason)
    ).toEqual(['session-switch', 'session-switch'])
  })

  it('blocks every current-generation approval when the prompt is aborted', async () => {
    const changes: ApprovalRegistryChange[] = []
    const registry = new ApprovalRegistry((change) => changes.push(change))
    const first = registry.request(request('first'))
    const second = registry.request(request('second'))

    expect(registry.clear(7, 'abort')).toBe(2)

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(registry.requests(7)).toEqual([])
    expect(changes.slice(-2)).toEqual([
      { status: 'blocked', request: request('first'), reason: 'abort' },
      { status: 'blocked', request: request('second'), reason: 'abort' }
    ])
  })
})
