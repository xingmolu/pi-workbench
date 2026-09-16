import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { CustomEndpointConfig } from './custom-endpoint-config'
import { CustomEndpointService } from './custom-endpoints'

describe('custom endpoints public SDK contract', () => {
  it.each(['!definitely-not-a-command', '$ENV', '$$literal', '密钥🔑!$'])(
    'roundtrips literal key %s with isolated canonical storage',
    async (key) => {
      const directory = fs.mkdtempSync(join(tmpdir(), 'pi-custom-auth-'))
      try {
        const runtime = await ModelRuntime.create({
          authPath: join(directory, 'auth.json'),
          modelsPath: join(directory, 'models.json'),
          modelsStorePath: join(directory, 'cache.json'),
          allowModelNetwork: false,
          refreshOnCreate: false
        })
        const config = new CustomEndpointConfig(join(directory, 'models.json'))
        const service = new CustomEndpointService({
          config,
          runtime,
          readSafety: () => ({
            generation: 0,
            sessionId: null,
            busy: false,
            promptPending: false,
            loginActive: false
          }),
          rebuildProjections: async () => {}
        })
        const result = await service.save({
          expectedRevision: (await config.read()).revision,
          endpoint: {
            label: 'Fixture',
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1',
            modelIds: ['m'],
            key
          }
        })
        expect(result).toMatchObject({ ok: true, credential: 'saved', runtime: 'synchronized' })
        expect(await runtime.getAuth(result.providerId!)).toMatchObject({ auth: { apiKey: key } })
        expect(JSON.stringify(result)).not.toContain(key)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('refresh retains old object routing until explicit same-ID rebind, preserving history across failed save', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-custom-session-'))
    try {
      const cwd = join(directory, 'cwd')
      const agentDir = join(directory, 'agent')
      fs.mkdirSync(cwd)
      fs.mkdirSync(agentDir)
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: join(agentDir, 'models.json'),
        modelsStorePath: join(agentDir, 'cache.json'),
        allowModelNetwork: false,
        refreshOnCreate: false
      })
      const config = new CustomEndpointConfig(join(agentDir, 'models.json'))
      const safety = {
        generation: 1,
        sessionId: 'fixture',
        busy: false,
        promptPending: false,
        loginActive: false
      }
      const endpoint = {
        label: 'Fixture',
        api: 'openai-completions' as const,
        baseUrl: 'http://127.0.0.1:1',
        modelIds: ['m']
      }
      const initialService = new CustomEndpointService({
        config,
        runtime,
        readSafety: () => safety,
        rebuildProjections: async () => {}
      })
      const saved = await initialService.save({
        expectedRevision: (await config.read()).revision,
        endpoint: { ...endpoint, key: 'fixture-local-placeholder' }
      })
      expect(saved.ok).toBe(true)
      const initial = runtime.getModel(saved.providerId!, 'm')!
      const settingsManager = SettingsManager.inMemory()
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true
      })
      await resourceLoader.reload()
      const manager = SessionManager.create(cwd, join(directory, 'sessions'))
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model: initial,
        sessionManager: manager,
        settingsManager,
        resourceLoader,
        noTools: 'all'
      })
      manager.appendMessage({ role: 'user', content: 'preserved fixture history', timestamp: 1 })
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'preserved fixture reply' }],
        api: 'openai-completions',
        provider: initial.provider,
        model: initial.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: 2
      })
      const before = manager.getEntries()
      const revised = { ...endpoint, baseUrl: 'http://127.0.0.1:2' }
      await config.update({
        id: saved.providerId!,
        expectedRevision: (await config.read()).revision,
        endpoint: revised
      })
      await runtime.refresh({ allowNetwork: false })
      expect(initial.baseUrl).toBe('http://127.0.0.1:1')
      expect(session.model).toBe(initial)
      expect(runtime.getModel(saved.providerId!, 'm')?.baseUrl).toBe('http://127.0.0.1:2')
      const service = new CustomEndpointService({
        config,
        runtime,
        readSafety: () => safety,
        getSession: () => session,
        setSessionBlocked: () => {},
        rebuildProjections: async () => {}
      })
      const failed = await service.save({
        id: saved.providerId!,
        expectedRevision: 'stale',
        endpoint: revised
      })
      expect(failed).toMatchObject({ ok: false, metadata: 'unchanged' })
      expect(manager.getEntries()).toEqual(before)
      expect(SessionManager.open(manager.getSessionFile()!, directory).getEntries()).toEqual(before)
      expect(session.model).toBe(initial)
      const rebound = await service.save({
        id: saved.providerId!,
        expectedRevision: (await config.read()).revision,
        endpoint: revised
      })
      expect(rebound.ok).toBe(true)
      // SDK checkAuth during setModel can rebuild the catalog again. Routing and
      // identity equality are the contract; catalog object reference is not stable.
      expect(session.model).not.toBe(initial)
      expect(session.model).toEqual(runtime.getModel(saved.providerId!, 'm'))
      expect(session.model?.baseUrl).toBe('http://127.0.0.1:2')
      expect(manager.getEntries().slice(0, before.length)).toEqual(before)
      expect(manager.getEntries().slice(before.length)).toEqual([
        expect.objectContaining({ type: 'model_change', provider: saved.providerId, modelId: 'm' })
      ])
      expect(SessionManager.open(manager.getSessionFile()!, directory).getEntries()).toEqual(
        manager.getEntries()
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
