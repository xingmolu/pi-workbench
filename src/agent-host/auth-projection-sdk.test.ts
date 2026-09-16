import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AccountSummary, ModelSummary } from '../shared/contracts'
import { selectProjectedProviders } from './auth-projection'
import { CustomEndpointConfig } from './custom-endpoint-config'
import { validateExactModelSelection } from './session-model'

const fixtures: string[] = []
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const FIXTURE_KEY = 'offline-fixture-only'
const secretLeak = (value: unknown) => JSON.stringify(value).includes(FIXTURE_KEY)

function projectAccounts(
  providers: readonly { id: string; name: string; auth: { oauth?: unknown } }[],
  stored: ReadonlyMap<string, { type: 'api_key' | 'oauth' }>,
  connected: ReadonlySet<string>
): AccountSummary[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    authType: stored.get(provider.id)?.type ?? (provider.auth.oauth ? 'oauth' : 'api_key'),
    connected: connected.has(provider.id),
    subscription: false,
    alias: provider.id.startsWith('openai-codex-')
  }))
}

describe('CLI models.json providers in composer projection', () => {
  it('makes a non-custom models.json provider selectable when the runtime has usable auth', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-auth-projection-'))
    fixtures.push(directory)
    const agentDir = join(directory, 'agent')
    mkdirSync(agentDir)
    const modelsPath = join(agentDir, 'models.json')
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          athenai: {
            name: 'athenai',
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: FIXTURE_KEY,
            models: [{ id: 'chat' }, { id: 'reason' }]
          },
          'keyless-gateway': {
            name: 'Keyless',
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1/v1',
            models: [{ id: 'orphan' }]
          }
        }
      })
    )
    writeFileSync(join(agentDir, 'auth.json'), '{}')
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath,
      modelsStorePath: join(agentDir, 'cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false
    })
    const catalog = await new CustomEndpointConfig(modelsPath).read()
    expect(catalog.endpoints.map((endpoint) => endpoint.id).sort()).toEqual([
      'athenai',
      'keyless-gateway'
    ])
    expect(catalog.endpoints.every((endpoint) => endpoint.editable === false)).toBe(true)
    expect(secretLeak(catalog)).toBe(false)

    const credentials = await runtime.listCredentials()
    expect(credentials.map((item) => item.providerId)).not.toContain('athenai')
    const available = await runtime.getAvailable()
    expect(available.map((model) => `${model.provider}/${model.id}`).sort()).toEqual([
      'athenai/chat',
      'athenai/reason'
    ])
    expect(await runtime.checkAuth('athenai')).toBeTruthy()
    expect(await runtime.checkAuth('keyless-gateway')).toBeUndefined()

    const relevant = selectProjectedProviders(runtime.getProviders(), {
      stored: new Set(credentials.map((item) => item.providerId)),
      modelsJson: new Set(catalog.endpoints.map((endpoint) => endpoint.id)),
      available: new Set(available.map((model) => model.provider))
    })
    const checks = await Promise.all(
      relevant.map(async (provider) => [provider.id, await runtime.checkAuth(provider.id)] as const)
    )
    const connected = new Set(checks.filter(([, auth]) => auth).map(([id]) => id))
    const stored = new Map(credentials.map((item) => [item.providerId, { type: item.type }]))
    const accounts = projectAccounts(relevant, stored, connected)
    const models: ModelSummary[] = available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning
    }))

    expect(accounts.find((account) => account.id === 'athenai')).toMatchObject({
      id: 'athenai',
      name: 'athenai',
      authType: 'api_key',
      connected: true,
      alias: false
    })
    expect(accounts.some((account) => account.id === 'keyless-gateway')).toBe(false)
    expect(secretLeak({ accounts, models, catalog })).toBe(false)
    expect(validateExactModelSelection(accounts, models, 'athenai', 'chat')).toEqual({
      providerId: 'athenai',
      modelId: 'chat'
    })
    expect(() =>
      validateExactModelSelection(accounts, models, 'keyless-gateway', 'orphan')
    ).toThrow('账号 keyless-gateway 未登录')
    expect(
      runtime
        .getAvailableSnapshot()
        .find((model) => model.provider === 'athenai' && model.id === 'chat')
    ).toBeTruthy()
  })
})
