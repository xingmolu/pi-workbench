import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension,
  type CreateAgentSessionRuntimeFactory
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { runSessionReplacement } from './session-transition'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function fixture(
  options: { cancel?: boolean; fail?: 'factory' | 'rebind' | 'withSession'; saved?: boolean } = {}
) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-fork-sdk-'))
  directories.push(directory)
  const cwd = join(directory, 'cwd'),
    agentDir = join(directory, 'agent'),
    sessionDir = join(directory, 'sessions')
  fs.mkdirSync(cwd)
  fs.mkdirSync(agentDir)
  vi.stubEnv('HOME', directory)
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  modelRuntime.registerProvider('fixture', {
    baseUrl: 'http://127.0.0.1:1',
    api: 'openai-completions',
    apiKey: 'fixture-only',
    models: [
      {
        id: 'exact',
        name: 'Exact',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024
      }
    ]
  })
  const model = modelRuntime.getModel('fixture', 'exact')!
  const manager = SessionManager.create(cwd, sessionDir)
  manager.appendModelChange('fixture', 'exact')
  const user = manager.appendMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'Structured question' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
    ],
    timestamp: 1
  })
  const assistant = (text: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-completions' as const,
    provider: 'fixture',
    model: 'exact',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop' as const,
    timestamp: 2
  })
  if (options.saved !== false) {
    manager.appendMessage(assistant('Excluded branch'))
    manager.branch(user)
    manager.appendMessage(assistant('Current branch'))
    manager.appendLabelChange(user, 'Question label')
  }
  const extensionFactories: InlineExtension[] = options.cancel
    ? [
        (pi) => {
          pi.on('session_before_fork', () => ({ cancel: true }))
        }
      ]
    : []
  let creations = 0,
    generation = 1,
    invalidation = 0
  const factory: CreateAgentSessionRuntimeFactory = async ({
    sessionManager,
    sessionStartEvent
  }) => {
    if (++creations === 2 && options.fail === 'factory') throw new Error('fixture factory failure')
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false }
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories
      }
    })
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      noTools: 'all'
    })
    await result.session.bindExtensions({ mode: 'rpc' })
    return { ...result, services, diagnostics: services.diagnostics }
  }
  let runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: manager })
  runtime.setBeforeSessionInvalidate(() => {
    invalidation++
  })
  runtime.setRebindSession(async () => {
    generation++
    if (options.fail === 'rebind') throw new Error('fixture rebind failure')
  })
  const source = runtime.session
  const replace = () =>
    runSessionReplacement({
      generationBeforeReplacement: generation,
      invalidationBeforeReplacement: invalidation,
      replaceSession: () =>
        runtime.fork(manager.getLeafId()!, {
          position: 'at',
          withSession: async () => {
            if (options.fail === 'withSession') throw new Error('fixture withSession failure')
          }
        }),
      refreshSessions: () => SessionManager.list(cwd, sessionDir),
      readGeneration: () => generation,
      readInvalidation: () => invalidation,
      recoverInvalidatedSession: async () => {
        runtime = await createAgentSessionRuntime(factory, {
          cwd,
          agentDir,
          sessionManager: manager
        })
        generation++
      },
      clearSessionAfterRecoveryFailure: async () => {
        throw new Error('unexpected recovery failure')
      },
      publishSnapshot: () => {}
    })
  return {
    directory,
    cwd,
    sessionDir,
    manager,
    source,
    get runtime() {
      return runtime
    },
    get generation() {
      return generation
    },
    get invalidation() {
      return invalidation
    },
    replace
  }
}

it('public runtime forks only the current path, preserves structured images and labels, and never prompts', async () => {
  const f = await fixture()
  const path = f.manager.getSessionFile()!,
    before = fs.readFileSync(path)
  const result = await f.replace()
  expect(result).toEqual({ cancelled: false })
  const child = f.runtime.session.sessionManager
  expect(f.runtime.session).not.toBe(f.source)
  expect(child.getSessionId()).not.toBe(f.manager.getSessionId())
  expect(child.getHeader()?.parentSession).toBe(path)
  expect(fs.readFileSync(path)).toEqual(before)
  expect(JSON.stringify(child.getEntries())).not.toContain('Excluded branch')
  expect(JSON.stringify(child.getEntries())).toContain('Current branch')
  expect(
    child.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user')
  ).toMatchObject({
    message: {
      content: [
        { type: 'text', text: 'Structured question' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ]
    }
  })
  expect(child.getEntries().filter((entry) => entry.type === 'label')).toHaveLength(1)
  expect(child.getEntries().filter((entry) => entry.type === 'message')).toHaveLength(2)
  expect(child.buildSessionContext().model).toEqual({ provider: 'fixture', modelId: 'exact' })
  await f.runtime.dispose()
})

it('actual before-fork cancellation leaves identity, generation and directory unchanged', async () => {
  const f = await fixture({ cancel: true })
  const files = fs.readdirSync(f.sessionDir)
  expect(await f.replace()).toEqual({ cancelled: true })
  expect(f.runtime.session).toBe(f.source)
  expect(f.generation).toBe(1)
  expect(f.invalidation).toBe(0)
  expect(fs.readdirSync(f.sessionDir)).toEqual(files)
  await f.runtime.dispose()
})

it('public SDK middle assistant boundary excludes later turns and later model changes without altering source', async () => {
  const f = await fixture()
  const boundary = f.manager.getBranch().find(e => e.type === 'message' && e.message.role === 'assistant')!
  f.manager.appendModelChange('fixture', 'later-model')
  f.manager.appendMessage({ role: 'user', content: 'Later question must be excluded', timestamp: 3 })
  const sourcePath = f.manager.getSessionFile()!
  const sourceBytes = fs.readFileSync(sourcePath)
  expect(await f.runtime.fork(boundary.id, { position: 'at' })).toEqual({ cancelled: false })
  const child = f.runtime.session.sessionManager
  expect(child.getBranch().filter(e => e.type === 'message').at(-1)?.id).toBe(boundary.id)
  expect(child.buildSessionContext().model).toEqual({ provider: 'fixture', modelId: 'exact' })
  expect(JSON.stringify(child.getEntries())).not.toContain('Later question')
  expect(JSON.stringify(child.getEntries())).not.toContain('later-model')
  expect(JSON.stringify(child.getEntries())).toContain('aW1hZ2U=')
  expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes)
  await f.runtime.dispose()
})

it.each(['invalid', 'unsaved'] as const)(
  'actual SDK %s target rejects before invalidation',
  async (kind) => {
    const f = await fixture({ saved: kind !== 'unsaved' })
    await expect(
      f.runtime.fork(kind === 'invalid' ? 'missing' : f.manager.getLeafId()!, { position: 'at' })
    ).rejects.toThrow()
    expect(f.runtime.session).toBe(f.source)
    expect(f.invalidation).toBe(0)
    await f.runtime.dispose()
  }
)

it('actual child file EISDIR failure leaves the source usable and does not remove the possible child', async () => {
  const f = await fixture()
  const source = f.manager.getSessionFile()!
  const originalOpen = fs.openSync
  let childPath: string | undefined
  const injected = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (
      typeof file === 'string' &&
      file.startsWith(f.sessionDir) &&
      file !== source &&
      flags === 'w'
    ) {
      childPath = file
      fs.mkdirSync(file)
    }
    return originalOpen(file, flags, mode)
  })
  syncBuiltinESMExports()
  try {
    await expect(f.replace()).rejects.toMatchObject({ code: 'EISDIR' })
  } finally {
    injected.mockRestore()
    syncBuiltinESMExports()
  }
  expect(f.runtime.session).toBe(f.source)
  expect(f.invalidation).toBe(0)
  expect(fs.statSync(childPath!).isDirectory()).toBe(true)
  await f.runtime.dispose()
})

it.each(['factory', 'rebind', 'withSession'] as const)(
  'public factory/%s failure reports actual recovery identity and keeps the created child',
  async (fail) => {
    const f = await fixture({ fail })
    await expect(f.replace()).rejects.toThrow(`fixture ${fail} failure`)
    expect(f.runtime.session).not.toBe(f.source)
    expect(f.generation).toBe(2)
    expect(f.invalidation).toBe(1)
    expect(f.runtime.session.sessionManager.getSessionId() === f.manager.getSessionId()).toBe(
      fail === 'factory'
    )
    expect((await SessionManager.list(f.cwd, f.sessionDir)).length).toBe(2)
    await f.runtime.dispose()
  }
)
