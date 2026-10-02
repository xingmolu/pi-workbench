import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import type { AccountQuota } from '../shared/account-quota'
import { t } from '../shared/i18n'

const URL = 'https://chatgpt.com/backend-api/wham/usage'
const windowSchema = z.object({
  used_percent: z.number().finite().min(0).max(100),
  limit_window_seconds: z.number().finite().positive().nullish(),
  reset_at: z.number().int().nonnegative().nullish()
})
const limitsSchema = z.object({
  primary_window: windowSchema.nullish(),
  secondary_window: windowSchema.nullish()
})
const usageSchema = z.object({
  plan_type: z.string().max(80).nullish(),
  rate_limit: limitsSchema.nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string().max(100).optional(),
        metered_feature: z.string().max(100).optional(),
        rate_limit: limitsSchema
      })
    )
    .max(9)
    .nullish()
})

export function parseQuota(body: unknown): Pick<AccountQuota, 'plan' | 'windows'> {
  const data = usageSchema.parse(body)
  const windows: AccountQuota['windows'] = []
  const add = (limits: z.infer<typeof limitsSchema> | null | undefined, prefix: string) => {
    for (const [key, label] of [
      ['primary_window', t('主要额度')],
      ['secondary_window', t('次要额度')]
    ] as const) {
      const window = limits?.[key]
      if (window)
        windows.push({
          label: `${prefix}${label}`,
          usedPercent: window.used_percent,
          ...(window.limit_window_seconds
            ? { windowMinutes: Math.ceil(window.limit_window_seconds / 60) }
            : {}),
          ...(window.reset_at != null ? { resetsAt: window.reset_at } : {})
        })
    }
  }
  add(data.rate_limit, '')
  for (const extra of data.additional_rate_limits ?? [])
    add(extra.rate_limit, `${extra.limit_name ?? extra.metered_feature ?? t('附加')} · `)
  return { ...(data.plan_type ? { plan: data.plan_type } : {}), windows }
}

type Runtime = Pick<
  ModelRuntime,
  'getProviders' | 'listCredentials' | 'isUsingSubscription' | 'getAuth'
>
export class AccountQuotaReader {
  generation = 0
  private requests = new Map<
    string,
    { controller: AbortController; promise: Promise<AccountQuota> }
  >()
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  invalidate(): void {
    this.generation++
    for (const request of this.requests.values()) request.controller.abort()
    this.requests.clear()
  }

  read(runtime: Runtime, providerId: string): Promise<AccountQuota> {
    const prior = this.requests.get(providerId)
    if (prior) return prior.promise
    const controller = new AbortController()
    const generation = this.generation
    const promise = this.load(runtime, providerId, generation, controller).finally(() => {
      if (this.requests.get(providerId)?.controller === controller) this.requests.delete(providerId)
    })
    this.requests.set(providerId, { controller, promise })
    return promise
  }

  private async load(
    runtime: Runtime,
    providerId: string,
    generation: number,
    controller: AbortController
  ): Promise<AccountQuota> {
    const base = {
      providerId,
      authGeneration: generation,
      fetchedAt: new Date().toISOString(),
      windows: []
    }
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      if (
        !/^openai-codex(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(providerId) ||
        !runtime.getProviders().some((provider) => provider.id === providerId) ||
        !(await runtime.listCredentials()).some(
          (item) => item.providerId === providerId && item.type === 'oauth'
        ) ||
        !runtime.isUsingSubscription(providerId)
      )
        return { ...base, state: 'signed-out', message: t('此账号没有可用的 Codex 订阅登录。') }
      const auth = await runtime.getAuth(providerId, {
        signal: controller.signal,
        minOAuthValidityMs: 300000
      })
      controller.signal.throwIfAborted()
      const token = auth?.auth.apiKey
      if (!token || token.length > 32768) throw new Error('No usable auth')
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
      )
      const accountId: unknown = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
      if (typeof accountId !== 'string' || !/^[\w-]{1,200}$/.test(accountId))
        throw new Error('No account id')
      const response = await this.fetcher(URL, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'ChatGPT-Account-Id': accountId,
          Accept: 'application/json'
        }
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Quota unavailable')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('No body')
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.length
          if (length > 65536) throw new Error('Response too large')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      controller.signal.throwIfAborted()
      if (generation !== this.generation) throw new Error('Auth changed')
      const data = parseQuota(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      return {
        ...base,
        ...data,
        state: data.windows.length ? 'available' : 'unavailable',
        ...(data.windows.length ? {} : { message: t('服务商未返回可展示的额度。') })
      }
    } catch {
      return {
        ...base,
        state: 'unavailable',
        message: t('暂时无法读取额度，请稍后刷新或重新登录。')
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
