import { describe, expect, it, vi } from 'vitest'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { AccountQuotaReader, parseQuota } from './account-quota'

const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`
const runtime = (id = 'openai-codex', type = 'oauth') =>
  ({
    getProviders: () => [{ id }],
    listCredentials: async () => [{ providerId: id, type }],
    isUsingSubscription: () => type === 'oauth',
    getAuth: vi.fn(async () => ({ auth: { apiKey: token } }))
  }) as unknown as ModelRuntime
const data = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: null
  }
}

describe('Codex quota', () => {
  it('preserves secondary/additional windows and nullable reset information', () => {
    expect(
      parseQuota({
        rate_limit: {
          primary_window: null,
          secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: null }
        },
        additional_rate_limits: [
          {
            limit_name: 'Review',
            rate_limit: {
              primary_window: { used_percent: 0, limit_window_seconds: null, reset_at: 1800000000 }
            }
          }
        ]
      })
    ).toEqual({
      windows: [
        { label: '次要额度', usedPercent: 100, windowMinutes: 10080 },
        { label: 'Review · 主要额度', usedPercent: 0, resetsAt: 1800000000 }
      ]
    })
  })
  it.each([401, 403])(
    'returns unavailable without exposing an HTTP %i response body',
    async (status) => {
      const service = new AccountQuotaReader(
        vi.fn<typeof fetch>(async () => new Response(token, { status }))
      )
      const result = await service.read(runtime(), 'openai-codex')
      expect(result.state).toBe('unavailable')
      expect(result.windows).toEqual([])
      expect(JSON.stringify(result)).not.toContain(token)
    }
  )
  it('aborts a stalled request at the timeout and permits a fresh read', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | null | undefined
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error(token)), { once: true })
        })
      })
      const service = new AccountQuotaReader(fetcher)
      const pending = service.read(runtime(), 'openai-codex')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10000)
      const result = await pending
      expect(signal?.aborted).toBe(true)
      expect(result.state).toBe('unavailable')
      expect(JSON.stringify(result)).not.toContain(token)
      fetcher.mockResolvedValueOnce(Response.json(data))
      expect((await service.read(runtime(), 'openai-codex')).state).toBe('available')
    } finally {
      vi.useRealTimers()
    }
  })
  it('projects exact valid windows and does not invent absent allowance', () => {
    expect(parseQuota(data)).toEqual({
      plan: 'plus',
      windows: [{ label: '主要额度', usedPercent: 32, windowMinutes: 300, resetsAt: 1800000000 }]
    })
    expect(parseQuota({})).toEqual({ windows: [] })
    expect(() => parseQuota({ rate_limit: { primary_window: { used_percent: -1 } } })).toThrow()
  })
  it('rejects non-Codex/API-key providers before resolving or sending their credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const [id, type] of [
      ['custom-test', 'oauth'],
      ['openai-codex', 'api_key']
    ]) {
      const source = runtime(id, type)
      expect((await new AccountQuotaReader(fetcher).read(source, id)).state).toBe('signed-out')
      expect(source.getAuth).not.toHaveBeenCalled()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('resolves the exact alias, sends only to fixed origin with no redirects, returns no token', async () => {
    const source = runtime('openai-codex-work')
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...data, secret: token }))
    const result = await new AccountQuotaReader(fetcher).read(source, 'openai-codex-work')
    expect(source.getAuth).toHaveBeenCalledWith(
      'openai-codex-work',
      expect.objectContaining({ minOAuthValidityMs: 300000 })
    )
    expect(fetcher).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({ redirect: 'error' })
    )
    expect(result.state).toBe('available')
    expect(JSON.stringify(result)).not.toContain(token)
  })
  it('invalidates pending same-provider old-account response and hides raw errors', async () => {
    let resolve!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
    const service = new AccountQuotaReader(fetcher)
    const pending = service.read(runtime(), 'openai-codex')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
    service.invalidate()
    resolve(Response.json(data))
    expect((await pending).state).toBe('unavailable')
    const fail = new AccountQuotaReader(
      vi.fn<typeof fetch>(async () => {
        throw new Error(token)
      })
    )
    expect(JSON.stringify(await fail.read(runtime(), 'openai-codex'))).not.toContain(token)
  })
  it('rejects oversized payloads and malformed schemas', async () => {
    for (const body of [
      'x'.repeat(65537),
      JSON.stringify({ rate_limit: { primary_window: { used_percent: 999 } } })
    ]) {
      const service = new AccountQuotaReader(vi.fn<typeof fetch>(async () => new Response(body)))
      expect((await service.read(runtime(), 'openai-codex')).state).toBe('unavailable')
    }
  })
})
