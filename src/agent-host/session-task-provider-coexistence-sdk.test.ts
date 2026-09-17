import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, fauxProvider } from '@earendil-works/pi-ai'
import { createSessionTaskExtension } from './session-task-extension'

async function runFixture(withSessionTask: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-task-provider-'))
  const cwd = join(directory, 'cwd')
  const agentDir = join(directory, 'agent')
  await mkdir(cwd)
  await mkdir(agentDir)
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-fixture-only' } })
  )

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const boot = fauxProvider({ provider: 'boot', models: [{ id: 'boot-model' }] })
  const fixture = fauxProvider({ provider: 'fixture', models: [{ id: 'offline' }] })
  modelRuntime.registerNativeProvider(boot.provider)
  await modelRuntime.setRuntimeApiKey('boot', 'fixture-only-not-a-credential')

  const fixtureExtension: InlineExtension = {
    name: 'fixture-provider',
    factory: (pi) => {
      pi.registerProvider(fixture.provider)
    }
  }
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      fixtureExtension,
      ...(withSessionTask ? [createSessionTaskExtension()] : [])
    ]
  })
  await resourceLoader.reload()
  const manager = SessionManager.inMemory(cwd)
  const previous = process.env.PI_DESKTOP_SESSION_WORKER
  if (withSessionTask) process.env.PI_DESKTOP_SESSION_WORKER = '1'
  else delete process.env.PI_DESKTOP_SESSION_WORKER

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: boot.getModel('boot-model')!,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    tools: withSessionTask ? ['read', 'session_task'] : ['read']
  })
  try {
    await session.bindExtensions({ mode: 'rpc' })
    await modelRuntime.refresh()
    return {
      providerIds: modelRuntime.getProviders().map((provider) => provider.id),
      available: modelRuntime
        .getAvailableSnapshot()
        .map((model) => `${model.provider}/${model.id}`),
      auth: await modelRuntime.checkAuth('fixture')
    }
  } finally {
    session.dispose()
    if (previous === undefined) delete process.env.PI_DESKTOP_SESSION_WORKER
    else process.env.PI_DESKTOP_SESSION_WORKER = previous
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SessionTask and provider extension coexistence', () => {
  it.each([
    ['provider extension alone', false],
    ['provider extension with SessionTask', true]
  ])('keeps fixture provider/auth available with %s', async (_label, withSessionTask) => {
    const result = await runFixture(withSessionTask)
    expect(result.providerIds).toContain('fixture')
    expect(result.available).toContain('fixture/offline')
    expect(result.auth).toBeTruthy()
  })
})
