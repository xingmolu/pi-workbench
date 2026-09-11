import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostRequest } from '../shared/contracts'
import { HostResponseBroker } from './host-response-broker'
import { EMPTY_SNAPSHOT } from '../renderer/src/store/pi-store'

describe('HostResponseBroker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('routes edit preparation as a bounded explicit result, never an ack', async () => {
    const broker = new HostResponseBroker({ createRequestId: () => 'edit' })
    const pending = broker.request(
      {
        type: 'session:edit:prepare',
        sessionId: 'source',
        generation: 1,
        entryId: 'user',
        leafId: 'leaf'
      },
      () => {}
    )
    const data = {
      kind: 'session-edit',
      result: {
        type: 'prepared',
        token: '60627dcd-1217-41a3-b9ef-0df68ebfe2dc',
        scope: { sessionId: 'source', generation: 1, entryId: 'user', leafId: 'leaf' },
        text: 'question',
        attachments: []
      }
    }
    broker.accept({ type: 'response', requestId: 'edit', ok: true, data })
    await expect(pending).resolves.toEqual(data)
  })

  it.each([true, false])(
    'forwards explicit fork cancellation=%s with actual identity and snapshot',
    async (cancelled) => {
      const broker = new HostResponseBroker({ createRequestId: () => 'fork' })
      const promise = broker.request(
        { type: 'session:fork', sessionId: 'source', generation: 1, entryId: 'leaf' },
        () => undefined
      )
      const data = {
        kind: 'session-fork',
        cancelled,
        snapshot: {
          ...EMPTY_SNAPSHOT,
          sessionId: cancelled ? 'source' : 'child',
          generation: cancelled ? 1 : 2
        }
      }
      broker.accept({ type: 'response', requestId: 'fork', ok: true, data })
      await expect(promise).resolves.toEqual(data)
    }
  )

  it('resolves a schema-valid explicit endpoint save outcome', async () => {
    const broker = new HostResponseBroker({ createRequestId: () => 'saved-endpoint' })
    const promise = broker.request(
      {
        type: 'endpoint:save',
        context: { projectPath: null, sessionId: null, generation: 0 },
        request: {
          expectedRevision: 'r',
          endpoint: {
            label: 'fixture',
            api: 'anthropic-messages',
            baseUrl: 'https://example.invalid',
            modelIds: ['a'],
            key: 'fixture-only'
          }
        }
      },
      () => undefined
    )
    const data = {
      kind: 'endpoint-save',
      result: {
        ok: true,
        providerId: 'custom-fixture',
        metadata: 'saved',
        credential: 'saved',
        runtime: 'synchronized',
        selection: 'unchanged',
        message: '端点已保存',
        snapshot: { revision: 'new', endpoints: [] }
      }
    }
    broker.accept({ type: 'response', requestId: 'saved-endpoint', ok: true, data })
    await expect(promise).resolves.toEqual(data)
    expect(broker.pendingCount).toBe(0)
  })

  it('accepts only the explicit endpoint response and rejects ack for saves', async () => {
    const broker = new HostResponseBroker({ createRequestId: () => 'endpoint-request' })
    const list = broker.request({ type: 'endpoint:list' }, () => undefined)
    broker.accept({
      type: 'response',
      requestId: 'endpoint-request',
      ok: true,
      data: {
        kind: 'endpoint-list',
        snapshot: { revision: 'r', endpoints: [] },
        configPath: '/fixture/models.json'
      }
    })
    await expect(list).resolves.toMatchObject({ kind: 'endpoint-list' })
    const save = broker.request(
      {
        type: 'endpoint:save',
        context: { projectPath: null, sessionId: null, generation: 0 },
        request: {
          expectedRevision: 'r',
          endpoint: {
            label: 'fixture',
            api: 'openai-completions',
            baseUrl: 'https://example.invalid',
            modelIds: ['a'],
            key: 'fixture-secret'
          }
        }
      },
      () => undefined
    )
    broker.accept({
      type: 'response',
      requestId: 'endpoint-request',
      ok: true,
      data: { kind: 'ack', sessionId: null, generation: 0, revision: 0 }
    })
    await expect(save).rejects.toThrow('响应类型不匹配')
  })

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
