import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeAttachmentPrompt } from './attachment-acceptance'

const root = mkdtempSync(join(tmpdir(), 'pi-attachment-sdk-'))
const originalHome = process.env.HOME
const originalAgentDir = process.env.PI_CODING_AGENT_DIR
const originalCwd = process.cwd()
beforeAll(() => {
  mkdirSync(join(root, 'home'))
  mkdirSync(join(root, 'agent'))
  mkdirSync(join(root, 'cwd'))
  process.env.HOME = join(root, 'home')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.chdir(join(root, 'cwd'))
})
afterAll(() => {
  process.chdir(originalCwd)
  process.env.HOME = originalHome
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  rmSync(root, { recursive: true, force: true })
})

async function fixture(handled = false) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const ai = await import('@earendil-works/pi-ai')
  const agentDir = join(root, 'agent')
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const faux = ai.fauxProvider({ models: [{ id: 'a' }], tokensPerSecond: 50 })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.setRuntimeApiKey(faux.provider.id, 'offline-fixture-only')
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  })
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: join(root, 'cwd'),
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: handled
      ? [
          (pi) => {
            pi.on('input', () => ({ action: 'handled' }))
          }
        ]
      : []
  })
  await resourceLoader.reload()
  const manager = sdk.SessionManager.inMemory(join(root, 'cwd'))
  const { session } = await sdk.createAgentSession({
    cwd: join(root, 'cwd'),
    agentDir,
    modelRuntime,
    model: modelRuntime.getModel(faux.provider.id, 'a')!,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    noTools: 'all'
  })
  await session.bindExtensions({})
  faux.setResponses([ai.fauxAssistantMessage('offline response '.repeat(5))])
  return { session, manager, modelRuntime, faux }
}

describe('SDK 0.84.4 attachment preflight receipt', () => {
  it('reports acceptance before a real offline model finishes', async () => {
    const { session } = await fixture()
    const observed = observeAttachmentPrompt(session, 'synthetic file text', 1000)
    expect(await observed.receipt).toBe('accepted')
    expect(session.isStreaming).toBe(true)
    await session.abort()
    await observed.finished
  })
  it('reports SDK preflight rejection', async () => {
    const { session } = await fixture()
    const first = observeAttachmentPrompt(session, 'first offline prompt', 1000)
    expect(await first.receipt).toBe('accepted')
    const observed = observeAttachmentPrompt(session, 'synthetic file text', 1000)
    expect(await observed.receipt).toBe('rejected')
    await observed.finished
    await session.abort()
    await first.finished
  })
  it('accepts an input extension handling the text without a user transcript entry', async () => {
    const { session, manager } = await fixture(true)
    const observed = observeAttachmentPrompt(session, 'synthetic file text', 1000)
    expect(await observed.receipt).toBe('accepted')
    await observed.finished
    expect(manager.getEntries().some((e) => e.type === 'message')).toBe(false)
  })
  it('keeps accepted after a model failure and never reissues the prompt', async () => {
    const { session, faux } = await fixture()
    let calls = 0
    faux.setResponses([
      () => {
        calls++
        throw new Error('offline model failed')
      }
    ])
    const observed = observeAttachmentPrompt(session, 'synthetic file text', 1000)
    expect(await observed.receipt).toBe('accepted')
    await observed.finished
    expect(calls).toBe(1)
    expect(await observed.receipt).toBe('accepted')
  })
  it('bounds missing callbacks and contains observer exceptions', async () => {
    expect(await observeAttachmentPrompt({ prompt: async () => {} }, 'x', 10).receipt).toBe(
      'uncertain'
    )
    const observed = observeAttachmentPrompt(
      {
        prompt: async (_, options) => {
          options?.preflightResult?.(true)
        }
      },
      'x',
      10,
      () => {
        throw new Error('observer')
      }
    )
    expect(await observed.receipt).toBe('accepted')
    await observed.finished
  })
})
