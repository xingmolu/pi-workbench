import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostRequest } from '../shared/contracts'
import { HostResponseBroker } from './host-response-broker'

describe('HostResponseBroker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects a schema-valid response whose result kind does not match the command', async () => {
    let dispatched: HostRequest | undefined
    const broker = new HostResponseBroker({ createRequestId: () => 'request-1' })
    const result = broker.request({ type: 'state:get' }, (request) => {
      dispatched = request
    })

    broker.accept({
      type: 'response',
      requestId: dispatched?.requestId,
      ok: true,
      data: { kind: 'ack', sessionId: null, generation: 0, revision: 0 }
    })

    await expect(result).rejects.toThrow('响应类型不匹配')
    expect(broker.pendingCount).toBe(0)
  })

  it('rejects an invalid response with a known request id immediately', async () => {
    let dispatched: HostRequest | undefined
    const broker = new HostResponseBroker({
      createRequestId: () => 'request-2',
      timeoutMs: 30_000
    })
    const result = broker.request({ type: 'prompt:abort' }, (request) => {
      dispatched = request
    })

    broker.accept({
      type: 'response',
      requestId: dispatched?.requestId,
      ok: true,
      data: { kind: 'ack', sessionId: null, generation: 'invalid', revision: 1 }
    })

    await expect(result).rejects.toThrow('无效响应')
    expect(broker.pendingCount).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(broker.pendingCount).toBe(0)
  })
})
