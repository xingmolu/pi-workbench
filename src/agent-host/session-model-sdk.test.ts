import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
import {
  guardModelMutation,
  SessionMutationGuard,
  SessionRuntimeUnsafeError
} from './session-mutation-safety'

async function fixture(directory: string, extensionFactories: InlineExtension[] = []) {
  const cwd = join(directory, 'cwd')
  const agentDir = join(directory, 'agent')
  fs.mkdirSync(cwd)
  fs.mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  modelRuntime.registerProvider('fixture-provider', {
    baseUrl: 'http://127.0.0.1:1',
    api: 'openai-completions',
    apiKey: 'fixture-only-not-a-credential',
    models: ['reasoning', 'plain'].map((id) => ({
      id,
      name: id,
      reasoning: id === 'reasoning',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024
    }))
  })
  const initial = modelRuntime.getModel('fixture-provider', 'reasoning')!
  const next = modelRuntime.getModel('fixture-provider', 'plain')!
  const settingsManager = SettingsManager.inMemory()
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories
  })
  await resourceLoader.reload()
  const manager = SessionManager.create(cwd, join(directory, 'sessions'))
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: initial,
    thinkingLevel: 'high',
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    noTools: 'all'
  })
  // A real assistant entry activates canonical persistence without sending any prompt.
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'preserved reply' }],
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
    timestamp: 1
  })
  return { session, manager, initial, next }
}

describe('public SDK model mutation persistence', () => {
  it('keeps real SDK auth rejection recoverable and allows a subsequent model change', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-model-auth-'))
    try {
      const { session, manager, next } = await fixture(directory)
      const before = manager.getEntries()
      const guard = new SessionMutationGuard()
      await expect(
        guard.run(() =>
          guardModelMutation(session, () =>
            session.setModel({
              ...next,
              provider: 'fixture-provider-without-auth'
            })
          )
        )
      ).rejects.toThrow('No API key')
      expect(manager.getEntries()).toEqual(before)
      await expect(
        guard.run(() => guardModelMutation(session, () => session.setModel(next)))
      ).resolves.toBeUndefined()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('appends canonical history even when selecting the identical model object', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-model-same-'))
    try {
      const { session, manager, initial } = await fixture(directory)
      const count = manager.getEntries().length
      const leaf = manager.getLeafId()
      await guardModelMutation(session, () => session.setModel(initial))
      expect(session.model).toBe(initial)
      expect(manager.getLeafId()).not.toBe(leaf)
      expect(
        SessionManager.open(manager.getSessionFile()!, directory).getEntries().slice(count)
      ).toEqual([expect.objectContaining({ type: 'model_change', modelId: initial.id })])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([1, 2])('stops after real filesystem failure at canonical append %i', async (failAt) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-model-failure-'))
    try {
      const { session, manager, next } = await fixture(directory)
      const path = manager.getSessionFile()!
      const originalEntries = SessionManager.open(path, directory).getEntries()
      const backup = join(directory, 'canonical-backup.jsonl')
      const originalAppend = fs.appendFileSync
      let appends = 0
      // Test-only public Node fs boundary injection, never SDK hooks: replace only
      // this fixture path by a directory at the selected append, then execute the
      // real appendFileSync so the actual SDK encounters a real EISDIR failure.
      const injection = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
        if (file !== path || ++appends !== failAt) return originalAppend(file, data, options)
        fs.renameSync(path, backup)
        fs.mkdirSync(path)
        try {
          return originalAppend(file, data, options)
        } finally {
          fs.rmdirSync(path)
          fs.renameSync(backup, path)
        }
      })
      syncBuiltinESMExports()
      const guard = new SessionMutationGuard()
      try {
        await expect(
          guard.run(() => guardModelMutation(session, () => session.setModel(next)))
        ).rejects.toMatchObject({
          message: '模型更新未完成，运行时已停止；请重新连接',
          cause: { code: 'EISDIR' }
        })
      } finally {
        injection.mockRestore()
        syncBuiltinESMExports()
      }
      expect(appends).toBe(failAt)
      expect(session.model).toBe(next)
      expect(session.thinkingLevel).toBe(failAt === 2 ? 'off' : 'high')
      const disk = SessionManager.open(path, directory)
      // Check the first successful append separately; the second failure must not
      // erase the model change already present in canonical disk history.
      const appended = disk.getEntries().slice(originalEntries.length)
      expect(appended).toHaveLength(failAt - 1)
      if (failAt === 2)
        expect(appended[0]).toMatchObject({ type: 'model_change', modelId: next.id })
      expect(disk.buildSessionContext().model?.modelId).toBe(failAt === 2 ? next.id : 'reasoning')
      expect(disk.buildSessionContext().thinkingLevel).toBe('high')
      expect(manager.getEntries()).toHaveLength(disk.getEntries().length + 1)
      expect(manager.getLeafId()).not.toBe(disk.getLeafId())
      await expect(guard.run(() => session.setModel(next))).rejects.toBeInstanceOf(
        SessionRuntimeUnsafeError
      )
      expect(SessionManager.open(path, directory).getEntries()).toEqual(disk.getEntries())
      // No disposal/shutdown hooks on the poisoned session.
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a throwing inline model_select extension but SDK setModel succeeds', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-model-extension-'))
    try {
      const { session, manager, next } = await fixture(directory, [
        (pi) => {
          pi.on('model_select', () => {
            throw new Error('extension fixture failure')
          })
        }
      ])
      const errors: string[] = []
      await session.bindExtensions({
        onError: (error) => {
          errors.push(error.error)
        }
      })
      const guard = new SessionMutationGuard()
      await expect(
        guard.run(() => guardModelMutation(session, () => session.setModel(next)))
      ).resolves.toBeUndefined()
      expect(errors).toEqual(['extension fixture failure'])
      await expect(guard.run(async () => 'operable')).resolves.toBe('operable')
      const disk = SessionManager.open(manager.getSessionFile()!, directory)
      expect(disk.buildSessionContext().model?.modelId).toBe(next.id)
      expect(disk.buildSessionContext().thinkingLevel).toBe('off')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
