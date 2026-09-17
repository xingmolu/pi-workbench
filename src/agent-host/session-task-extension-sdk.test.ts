import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-task-sdk-'))
  const cwd = join(directory, 'cwd')
  const agentDir = join(directory, 'agent')
  await mkdir(cwd)
  await mkdir(agentDir)

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const faux = fauxProvider({ models: [{ id: 'offline' }] })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.setRuntimeApiKey(faux.provider.id, 'fixture-only-not-a-credential')

  let activeAtSessionStart: string[] = []
  const observer: InlineExtension = {
    name: 'session-task-active-observer',
    factory: (pi) => {
      pi.on('session_start', () => {
        activeAtSessionStart = pi.getActiveTools()
      })
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
    extensionFactories: [createSessionTaskExtension(), observer]
  })
  await resourceLoader.reload()
  const manager = SessionManager.inMemory(cwd)
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel('offline')!,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    tools: ['read']
  })
  await session.bindExtensions({ mode: 'rpc' })

  return {
    directory,
    session,
    activeAtSessionStart: () => activeAtSessionStart
  }
}

describe('SessionTask Pi SDK activation', () => {
  it('activates session_task even when the initial host allowlist omits it', async () => {
    const value = await fixture()
    try {
      expect(value.activeAtSessionStart()).toContain('read')
      expect(value.activeAtSessionStart()).toContain('session_task')
    } finally {
      value.session.dispose()
      await rm(value.directory, { recursive: true, force: true })
    }
  })
})
