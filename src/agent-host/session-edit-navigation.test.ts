import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import * as navigation from './session-edit-navigation'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  vi.unstubAllEnvs()
})

async function fixture(extensions: InlineExtension[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-edit-navigation-'))
  dirs.push(directory)
  vi.stubEnv('HOME', directory)
  const cwd = join(directory, 'cwd'),
    agentDir = join(directory, 'agent')
  mkdirSync(cwd)
  mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const manager = SessionManager.inMemory(cwd)
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
    extensionFactories: extensions
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    noTools: 'all'
  })
  await session.bindExtensions({ mode: 'rpc' })
  manager.resetLeaf()
  return { session, manager }
}

it.each(['root', 'user', 'custom', 'metadata'])(
  'moves a latest user leaf to its exact %s parent using public SDK',
  async (parent) => {
    const f = await fixture()
    if (parent === 'user')
      f.manager.appendMessage({ role: 'user', content: 'parent', timestamp: 1 })
    if (parent === 'custom') f.manager.appendCustomMessageEntry('fixture', 'parent', false)
    if (parent === 'metadata') f.manager.appendThinkingLevelChange('off')
    const parentId = f.manager.getLeafId()
    const id = f.manager.appendMessage({ role: 'user', content: 'edit', timestamp: 2 })
    const entries = f.manager.getEntries()
    const sessionId = f.manager.getSessionId()
    const result = await navigation.navigateToEditedUserParent(f.session, id, {
      signal: new AbortController().signal,
      revalidate: () => {}
    })
    expect(result).toEqual({ cancelled: false, mutated: true })
    expect(f.manager.getLeafId()).toBe(parentId)
    expect(f.manager.getSessionId()).toBe(sessionId)
    expect(f.manager.getEntries()).toEqual(entries)
    expect(f.session.agent.state.messages).toEqual(f.manager.buildSessionContext().messages)
    f.session.dispose()
  }
)

it('matches SDK before-tree preparation and context for an ordinary nonleaf user', async () => {
  const events: unknown[] = []
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', (event) => {
        events.push(event.preparation)
      })
    }
  ])
  f.manager.appendMessage({ role: 'user', content: 'parent', timestamp: 1 })
  const id = f.manager.appendMessage({ role: 'user', content: 'edit', timestamp: 2 })
  const leaf = f.manager.appendCustomEntry('fixture', {})
  await f.session.navigateTree(id, { summarize: false })
  const sdkMessages = f.session.agent.state.messages
  f.manager.branch(leaf)
  await navigation.navigateToEditedUserParent(f.session, id, {
    signal: new AbortController().signal,
    revalidate: () => {}
  })
  expect(events[1]).toMatchObject(events[0] as object)
  expect(f.session.agent.state.messages).toEqual(sdkMessages)
  f.session.dispose()
})

it('honors cancellation without navigating and never overwrites changes made by a hook', async () => {
  let cancel = true
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', () => ({ cancel }))
    }
  ])
  const id = f.manager.appendMessage({ role: 'user', content: 'edit', timestamp: 2 })
  expect(
    await navigation.navigateToEditedUserParent(f.session, id, {
      signal: new AbortController().signal,
      revalidate: () => {}
    })
  ).toEqual({ cancelled: true, mutated: false })
  expect(f.manager.getLeafId()).toBe(id)
  cancel = false
  await expect(
    navigation.navigateToEditedUserParent(f.session, id, {
      signal: new AbortController().signal,
      revalidate: () => {
        throw new Error('stale')
      }
    })
  ).rejects.toThrow('stale')
  expect(f.manager.getLeafId()).toBe(id)
  f.session.dispose()
})

it('public extension runner reports thrown hooks and continues as SDK navigateTree does', async () => {
  const errors: unknown[] = []
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', () => {
        throw new Error('fixture hook failure')
      })
    }
  ])
  await f.session.bindExtensions({
    mode: 'rpc',
    onError: (error) => {
      errors.push(error)
    }
  })
  const id = f.manager.appendMessage({ role: 'user', content: 'edit', timestamp: Date.now() })
  expect(
    await navigation.navigateToEditedUserParent(f.session, id, {
      signal: new AbortController().signal,
      revalidate: () => {}
    })
  ).toEqual({ cancelled: false, mutated: true })
  expect(errors).toHaveLength(1)
  expect(f.manager.getLeafId()).toBe(null)
  f.session.dispose()
})
