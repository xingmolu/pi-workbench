import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai'
import * as editing from './session-edit'
const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true }))
  vi.unstubAllEnvs()
})

it.each(['input', 'before_agent_start'] as const)(
  'Stop during delayed %s prevents future model delegation and permits a later explicit prompt',
  async (phase) => {
    let enabled = false,
      entered = false,
      release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const f = await fixture([
      (pi) => {
        const wait = async () => {
          if (enabled) {
            entered = true
            await gate
          }
        }
        if (phase === 'input')
          pi.on('input', async () => {
            await wait()
            return { action: 'continue' }
          })
        else
          pi.on('before_agent_start', async () => {
            await wait()
          })
      }
    ])
    await f.turn('question')
    const original = f.runtime.session.agent.streamFunction
    let delegates = 0
    const delegated: typeof original = (...args) => {
      delegates++
      return original(...args)
    }
    f.runtime.session.agent.streamFunction = delegated
    const edit = f.prepare()
    if (edit.type !== 'prepared') throw new Error('prepare')
    enabled = true
    f.faux.setResponses([fauxAssistantMessage('must not execute')])
    const pending = f.service.send({
      token: edit.token,
      submissionId: randomUUID(),
      text: 'stopped edit'
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    f.service.abort()
    await f.runtime.session.abort()
    expect(f.service.pending).toBe(true)
    expect(f.prepare()).toMatchObject({ type: 'error' })
    release()
    await pending
    await vi.waitFor(() => expect(f.service.pending).toBe(false))
    expect(delegates).toBe(0)
    expect(JSON.stringify(f.manager.getEntries())).not.toContain('must not execute')
    expect(f.runtime.session.agent.streamFunction).toBe(delegated)
    enabled = false
    await f.turn('explicit new task')
    expect(delegates).toBe(1)
    expect(JSON.stringify(f.manager.getEntries())).toContain('reply explicit new task')
    await f.runtime.dispose()
  }
)
async function fixture(
  extensions: InlineExtension[] = [],
  options: { rebindFailure?: boolean; refresh?: () => Promise<void> } = {}
) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-edit-sdk-'))
  dirs.push(directory)
  vi.stubEnv('HOME', directory)
  const cwd = join(directory, 'cwd'),
    agentDir = join(directory, 'agent')
  fs.mkdirSync(cwd)
  fs.mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const faux = fauxProvider({
    models: [
      { id: 'a', reasoning: true, input: ['text', 'image'] },
      { id: 'b', reasoning: true, input: ['text', 'image'] }
    ],
    tokensPerSecond: 100000
  })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.setRuntimeApiKey(faux.provider.id, 'offline-fixture-only')
  const manager = SessionManager.create(cwd, join(directory, 'sessions'))
  const runtime = await createAgentSessionRuntime(
    async ({ sessionManager, sessionStartEvent }) => {
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
          extensionFactories: extensions
        }
      })
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: modelRuntime.getModel(faux.provider.id, 'a')!,
        noTools: 'all'
      })
      await result.session.bindExtensions({ mode: 'rpc' })
      return { ...result, services, diagnostics: services.diagnostics }
    },
    { cwd, agentDir, sessionManager: manager }
  )
  let generation = 1,
    busy = false,
    unavailable = false,
    now = 1
  const read = () => ({ runtime, session: runtime.session, generation, busy, unavailable })
  const service = new editing.SessionEditService({
    read,
    refresh: options.refresh ?? (async () => {}),
    rebind: async () => {
      generation++
      if (options.rebindFailure) throw new Error('fixture rebind failure')
    },
    publish: () => {},
    now: () => now
  })
  const prepare = () =>
    service.prepare({
      sessionId: manager.getSessionId(),
      generation,
      entryId: editing.latestUserId(manager)!,
      leafId: manager.getLeafId()
    })
  const turn = async (text: string) => {
    faux.setResponses([fauxAssistantMessage(`reply ${text}`)])
    await runtime.session.prompt(text)
  }
  return {
    directory,
    manager,
    runtime,
    service,
    prepare,
    turn,
    faux,
    modelRuntime,
    setBusy: (v: boolean) => {
      busy = v
    },
    setUnavailable: (v: boolean) => {
      unavailable = v
    },
    advance: () => {
      now += 900001
    },
    read
  }
}

it('edit request gate never restores over an extension replacement of the public delegate', async () => {
  let replace: (() => void) | undefined
  const f = await fixture([
    (pi) => {
      pi.on('input', () => {
        if (!replace) return { action: 'continue' }
        replace()
        return { action: 'handled' }
      })
    }
  ])
  await f.turn('question')
  const original = f.runtime.session.agent.streamFunction
  const replacement: typeof original = (...args) => original(...args)
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  replace = () => {
    f.runtime.session.agent.streamFunction = replacement
  }
  await f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'handled edit' })
  await vi.waitFor(() => expect(f.service.pending).toBe(false))
  expect(f.runtime.session.agent.streamFunction).toBe(replacement)
  await f.runtime.dispose()
})
it('same-runtime send preserves session/file and old entries while new user attaches to exact parent', async () => {
  const f = await fixture()
  await f.turn('first')
  await f.turn('second')
  const id = editing.latestUserId(f.manager)!,
    original = f.manager.getEntry(id)!
  const file = f.manager.getSessionFile()!,
    before = fs.readFileSync(file),
    entries = f.manager.getEntries(),
    sessionId = f.manager.getSessionId()
  const prepared = f.prepare()
  expect(prepared.type).toBe('prepared')
  if (prepared.type !== 'prepared') throw new Error('prepare failed')
  expect(fs.readFileSync(file)).toEqual(before)
  f.service.cancel(prepared.token)
  expect(fs.readFileSync(file)).toEqual(before)
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare failed')
  const submissionId = randomUUID()
  f.faux.setResponses([fauxAssistantMessage('edited answer')])
  const receipt = await f.service.send({ token: edit.token, submissionId, text: 'changed' })
  expect(receipt).toMatchObject({
    type: 'receipt',
    receipt: { status: 'accepted', sessionId, mutated: true }
  })
  await vi.waitFor(() => {
    expect(JSON.stringify(f.manager.getBranch())).toContain('edited answer')
    expect(f.runtime.session.isIdle).toBe(true)
  })
  expect(f.manager.getSessionFile()).toBe(file)
  expect(f.manager.getEntries().slice(0, entries.length)).toEqual(entries)
  const user = f.manager
    .getBranch()
    .findLast((e) => e.type === 'message' && e.message.role === 'user')!
  expect(user.parentId).toBe(original.parentId)
  expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain('second')
  const after = fs.readFileSync(file)
  expect(await f.service.send({ token: edit.token, submissionId, text: 'changed' })).toMatchObject({
    type: 'receipt',
    receipt: { status: 'accepted' }
  })
  expect(fs.readFileSync(file)).toEqual(after)
  expect(
    await f.service.send({ token: edit.token, submissionId, text: 'different' })
  ).toMatchObject({ type: 'error' })
  expect(SessionManager.open(file).buildSessionContext().messages).toEqual(
    f.manager.buildSessionContext().messages
  )
  await f.runtime.dispose()
})
it('preparation and send enforce busy, expiry, current leaf and unavailable model without movement', async () => {
  const f = await fixture()
  await f.turn('question')
  const before = f.manager.getLeafId()
  f.setBusy(true)
  expect(f.prepare()).toMatchObject({ type: 'error' })
  f.setBusy(false)
  f.setUnavailable(true)
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('view allowed')
  expect(
    await f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  ).toMatchObject({ type: 'receipt', receipt: { status: 'rejected', mutated: false } })
  expect(f.manager.getLeafId()).toBe(before)
  f.setUnavailable(false)
  const next = f.prepare()
  if (next.type !== 'prepared') throw new Error('prepare')
  f.advance()
  expect(
    await f.service.send({ token: next.token, submissionId: randomUUID(), text: 'changed' })
  ).toMatchObject({ type: 'receipt', receipt: { status: 'rejected' } })
  expect(f.manager.getLeafId()).toBe(before)
  await f.runtime.dispose()
})
it('input handled acceptance is not a durable message guarantee', async () => {
  let handled = false
  const f = await fixture([
    (pi) => {
      pi.on('input', () => (handled ? { action: 'handled' } : { action: 'continue' }))
    }
  ])
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  const count = f.manager.getEntries().length
  handled = true
  expect(
    await f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  ).toMatchObject({ type: 'receipt', receipt: { status: 'accepted' } })
  expect(f.manager.getEntries()).toHaveLength(count)
  await f.runtime.dispose()
})

it('detects a real before-tree hook append even when the hook cancels', async () => {
  let mutation: (() => void) | undefined
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', () => {
        mutation?.()
        return { cancel: true }
      })
    }
  ])
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  mutation = () => {
    f.manager.appendCustomEntry('hook-owned', {})
  }
  const result = await f.service.send({
    token: edit.token,
    submissionId: randomUUID(),
    text: 'changed'
  })
  expect(result).toMatchObject({
    type: 'receipt',
    receipt: { status: 'failed-after-mutation', mutated: true, generation: 2 }
  })
  expect(f.manager.getLeafEntry()).toMatchObject({ type: 'custom', customType: 'hook-owned' })
  expect(JSON.stringify(f.manager.getEntries())).not.toContain('changed')
  await f.runtime.dispose()
})

it('does not overwrite an actual hook append or changed model config', async () => {
  let mutation: (() => void) | undefined
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', () => {
        mutation?.()
      })
    }
  ])
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  mutation = () => {
    f.manager.appendCustomEntry('hook-owned', {})
  }
  expect(
    await f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  ).toMatchObject({ type: 'receipt', receipt: { status: 'failed-after-mutation' } })
  expect(f.manager.getLeafEntry()).toMatchObject({ customType: 'hook-owned' })
  await f.runtime.dispose()
})

it('rebind failure preserves original cause and does not prompt or rebind twice', async () => {
  const f = await fixture([], { rebindFailure: true })
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  await expect(
    f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  ).rejects.toMatchObject({ name: 'Error', cause: { message: 'fixture rebind failure' } })
  expect(f.read().generation).toBe(2)
  expect(JSON.stringify(f.manager.getEntries())).not.toContain('changed')
  await f.runtime.dispose()
})

it('real label append filesystem failure stops the runtime with original cause', async () => {
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', () => ({ label: 'extension label' }))
    }
  ])
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  const path = f.manager.getSessionFile()!,
    backup = join(f.directory, 'backup.jsonl'),
    original = fs.appendFileSync
  // Public filesystem boundary: actual append sees EISDIR; no SDK internals.
  const injection = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, opts) => {
    if (file !== path) return original(file, data, opts)
    fs.renameSync(path, backup)
    fs.mkdirSync(path)
    try {
      return original(file, data, opts)
    } finally {
      fs.rmdirSync(path)
      fs.renameSync(backup, path)
    }
  })
  syncBuiltinESMExports()
  try {
    await expect(
      f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
    ).rejects.toMatchObject({ cause: { code: 'EISDIR' } })
  } finally {
    injection.mockRestore()
    syncBuiltinESMExports()
  }
  expect(JSON.stringify(f.manager.getEntries())).not.toContain('changed')
  await f.runtime.dispose()
})

it('releases obsolete completed tokens at capacity without permitting their replay', async () => {
  const f = await fixture([
    (pi) => {
      pi.on('input', () => ({ action: 'handled' }))
    }
  ])
  let first: { token: string; submissionId: string; text: string } | undefined
  for (let i = 0; i < 34; i++) {
    f.manager.appendMessage({ role: 'user', content: `question ${i}`, timestamp: Date.now() })
    const edit = f.prepare()
    if (edit.type !== 'prepared') throw new Error('prepare')
    const command = { token: edit.token, submissionId: randomUUID(), text: `changed ${i}` }
    first ??= command
    expect(await f.service.send(command)).toMatchObject({
      type: 'receipt',
      receipt: { status: 'accepted' }
    })
    await vi.waitFor(() => expect(f.service.pending).toBe(false))
  }
  const before = f.manager.getEntries()
  expect(await f.service.send(first!)).toMatchObject({ type: 'error' })
  expect(f.manager.getEntries()).toEqual(before)
  await f.runtime.dispose()
})

it.each(['text', 'image'])(
  'unsaved first-user root %s edit retains current model/thinking on canonical reload',
  async (shape) => {
    const f = await fixture()
    f.manager.resetLeaf()
    const id = f.manager.appendMessage({
      role: 'user',
      content:
        shape === 'text'
          ? 'original root'
          : [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }],
      timestamp: Date.now()
    })
    expect(f.manager.getEntry(id)?.parentId).toBe(null)
    await f.runtime.session.setModel(f.modelRuntime.getModel(f.faux.provider.id, 'b')!, {
      persist: false
    })
    f.runtime.session.setThinkingLevel('high')
    const edit = f.prepare()
    if (edit.type !== 'prepared') throw new Error('prepare')
    f.faux.setResponses([fauxAssistantMessage('root edit answer')])
    expect(
      await f.service.send({
        token: edit.token,
        submissionId: randomUUID(),
        text: shape === 'text' ? 'changed root' : ''
      })
    ).toMatchObject({ type: 'receipt', receipt: { status: 'accepted' } })
    await vi.waitFor(() =>
      expect(JSON.stringify(f.manager.getBranch())).toContain('root edit answer')
    )
    const branch = f.manager.getBranch()
    expect(branch[0]).toMatchObject({
      type: 'model_change',
      provider: f.faux.provider.id,
      modelId: 'b',
      parentId: null
    })
    expect(branch[1]).toMatchObject({ type: 'thinking_level_change', thinkingLevel: 'high' })
    const disk = SessionManager.open(f.manager.getSessionFile()!)
    expect(disk.buildSessionContext().model).toEqual({ provider: f.faux.provider.id, modelId: 'b' })
    expect(disk.buildSessionContext().thinkingLevel).toBe('high')
    expect(disk.getEntries().some((e) => e.id === id)).toBe(true)
    expect(f.runtime.session.model?.id).toBe('b')
    await f.runtime.dispose()
  }
)

it('retains compaction ancestors and input transform while honoring a single real label', async () => {
  let enabled = false,
    hooks = 0
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', () => {
        hooks++
        return { label: 'edited source' }
      })
      pi.on('input', () =>
        enabled ? { action: 'transform', text: 'extension transformed' } : { action: 'continue' }
      )
    }
  ])
  await f.turn('first')
  f.manager.appendCompaction('retained summary', editing.latestUserId(f.manager)!, 123)
  await f.turn('second')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  enabled = true
  f.faux.setResponses([fauxAssistantMessage('transformed answer')])
  expect(
    await f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  ).toMatchObject({ type: 'receipt', receipt: { status: 'accepted' } })
  await vi.waitFor(() =>
    expect(JSON.stringify(f.manager.getBranch())).toContain('transformed answer')
  )
  expect(hooks).toBe(1)
  expect(f.manager.getEntries().filter((e) => e.type === 'label')).toHaveLength(1)
  expect(JSON.stringify(f.manager.buildSessionContext().messages)).toContain('retained summary')
  expect(JSON.stringify(f.manager.buildSessionContext().messages)).toContain(
    'extension transformed'
  )
  await f.runtime.dispose()
})

it('host Stop waits out a noncooperating before hook without starting a second operation', async () => {
  let release!: () => void,
    entered = false
  const gate = new Promise<void>((done) => {
    release = done
  })
  const f = await fixture([
    (pi) => {
      pi.on('session_before_tree', async () => {
        entered = true
        await gate
      })
    }
  ])
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  const leaf = f.manager.getLeafId()
  const pending = f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  await vi.waitFor(() => expect(entered).toBe(true))
  f.service.abort()
  expect(f.service.pending).toBe(true)
  expect(f.prepare()).toMatchObject({ type: 'error' })
  release()
  expect(await pending).toMatchObject({
    type: 'receipt',
    receipt: { status: 'cancelled', mutated: false }
  })
  expect(f.manager.getLeafId()).toBe(leaf)
  await f.runtime.dispose()
})

it('Stop during auth refresh cancels before hooks and cancel cannot falsely report an inflight send as cancelled', async () => {
  let release!: () => void,
    entered = false
  const gate = new Promise<void>((done) => {
    release = done
  })
  const f = await fixture([], {
    refresh: async () => {
      entered = true
      await gate
    }
  })
  await f.turn('question')
  const edit = f.prepare()
  if (edit.type !== 'prepared') throw new Error('prepare')
  const leaf = f.manager.getLeafId()
  const pending = f.service.send({ token: edit.token, submissionId: randomUUID(), text: 'changed' })
  await vi.waitFor(() => expect(entered).toBe(true))
  expect(f.service.cancel(edit.token)).toMatchObject({ type: 'error' })
  f.service.abort()
  release()
  expect(await pending).toMatchObject({
    type: 'receipt',
    receipt: { status: 'cancelled', mutated: false }
  })
  expect(f.manager.getLeafId()).toBe(leaf)
  await f.runtime.dispose()
})
