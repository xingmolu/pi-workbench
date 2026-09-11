import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension
} from '@earendil-works/pi-coding-agent'
import {
  InMemoryCredentialStore,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Model
} from '@earendil-works/pi-ai'
import { ConversationProjection } from './conversation-projection'
import {
  DisplayFailureQuarantine,
  HistoryModelObserver,
  SessionHistoryController
} from './session-history-controller'

async function fixture(
  directory: string,
  extensionFactories: InlineExtension[] = [],
  fixtureTools = false
) {
  const cwd = join(directory, 'cwd')
  const agentDir = join(directory, 'agent')
  mkdirSync(cwd)
  mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const faux = fauxProvider({ models: [{ id: 'a' }, { id: 'b' }], tokensPerSecond: 100000 })
  modelRuntime.registerNativeProvider(faux.provider)
  // pi.setModel additionally checks configured auth, even for an offline provider.
  await modelRuntime.setRuntimeApiKey(faux.provider.id, 'fixture-only-not-a-credential')
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
    extensionFactories
  })
  await resourceLoader.reload()
  const manager = SessionManager.inMemory(cwd)
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel('a')!,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    noTools: fixtureTools ? 'builtin' : 'all'
  })
  await session.bindExtensions({ mode: 'rpc' })
  return { session, manager, faux }
}

describe('offline public SDK canonical lifecycle', () => {
  it('routes real SDK tool start, update and end to the current canonical occurrence of a reused ID', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-history-sdk-tools-'))
    try {
      let execution = 0
      const { session, faux } = await fixture(
        directory,
        [
          {
            name: 'fixture-tools',
            factory: (pi) => {
              pi.registerTool({
                name: 'fixture_tool',
                label: 'Fixture tool',
                description: 'Pure in-memory fixture',
                parameters: Type.Object({}),
                execute: async (_id, _args, _signal, update) => {
                  execution++
                  update?.({
                    content: [{ type: 'text', text: `partial ${execution}` }],
                    details: {}
                  })
                  return { content: [{ type: 'text', text: `final ${execution}` }], details: {} }
                }
              })
            }
          }
        ],
        true
      )
      const projection = new ConversationProjection()
      const history = new SessionHistoryController(projection)
      const failures: string[] = []
      const quarantine = new DisplayFailureQuarantine(
        (exit) => exit(),
        (message) => failures.push(message)
      )
      const toolEvents: string[] = []
      history.connect(session, 1, {
        quarantine,
        onCommitted: () => {},
        onEvent: (event) => {
          if (event.type === 'message_update') history.update(event.message)
          if (event.type === 'tool_execution_start') {
            const current = projection
              .view()
              .filter((node) => node.type === 'tool')
              .at(-1)!
            expect(current.id).toMatch(/^entry:/)
            expect(current).toMatchObject({ status: 'queued' })
            history.updateTool(event.toolCallId, { status: 'running' })
            toolEvents.push('start')
          }
          if (event.type === 'tool_execution_update') {
            history.updateTool(event.toolCallId, {
              status: 'running',
              output: `partial ${execution}`
            })
            expect(
              projection
                .view()
                .filter((node) => node.type === 'tool')
                .at(-1)
            ).toMatchObject({ output: `partial ${execution}` })
            toolEvents.push('update')
          }
          if (event.type === 'tool_execution_end') {
            history.updateTool(event.toolCallId, {
              status: 'success',
              output: `final ${execution}`,
              durationMs: execution
            })
            toolEvents.push('end')
          }
        }
      })
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('fixture_tool', {}, { id: 'reused' }), {
          stopReason: 'toolUse'
        }),
        fauxAssistantMessage('first answer'),
        fauxAssistantMessage(fauxToolCall('fixture_tool', {}, { id: 'reused' }), {
          stopReason: 'toolUse'
        }),
        fauxAssistantMessage('second answer')
      ])
      await session.prompt('first')
      await session.prompt('second')
      expect(failures).toEqual([])
      expect(toolEvents).toEqual(['start', 'update', 'end', 'start', 'update', 'end'])
      expect(projection.view().filter((node) => node.type === 'tool')).toMatchObject([
        { status: 'success', output: 'final 1', durationMs: 1 },
        { status: 'success', output: 'final 2', durationMs: 2 }
      ])
      session.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('observes public slash and idle extension model changes; same-model append waits for a healthy refresh', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-history-model-'))
    try {
      let target: { manager: SessionManager; generation: number } | null = null
      let selected!: Model<string>
      let setModel!: (model: Model<string>) => Promise<boolean>
      let scheduled = 0
      const observer = new HistoryModelObserver(
        () => target,
        () => scheduled++
      )
      const { session, manager, faux } = await fixture(directory, [
        {
          name: 'fixture-history-model',
          factory: (pi) => {
            setModel = (model) => pi.setModel(model)
            pi.on('model_select', (_event, ctx) => observer.observe(() => ctx.sessionManager))
            pi.registerCommand('history-model', {
              description: 'fixture model switch',
              handler: async () => {
                await pi.setModel(selected)
              }
            })
          }
        }
      ])
      target = { manager, generation: 1 }
      const projection = new ConversationProjection()
      const history = new SessionHistoryController(projection)
      history.bind(manager, 1)
      const originalSessionId = manager.getSessionId()
      selected = faux.getModel('b')!
      await session.prompt('/history-model')
      expect(session.model?.id).toBe('b')
      expect(observer.take()).toBe(true)
      history.refresh()
      expect(projection.view().at(-1)).toMatchObject({ type: 'model', modelId: 'b' })
      await setModel(faux.getModel('a')!)
      expect(observer.take()).toBe(true)
      history.refresh()
      expect(projection.view().at(-1)).toMatchObject({ type: 'model', modelId: 'a' })
      const before = projection.view().map((node) => node.id)
      const scheduledBefore = scheduled
      await setModel(faux.getModel('a')!)
      expect(observer.take()).toBe(false)
      expect(scheduled).toBe(scheduledBefore)
      expect(projection.view().map((node) => node.id)).toEqual(before)
      history.refresh()
      expect(projection.view()).toHaveLength(before.length + 1)
      expect(manager.getSessionId()).toBe(originalSessionId)
      expect(faux.state.callCount).toBe(0)
      session.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns display failure normally to SDK without triggering recovery writes or later callbacks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-history-display-failure-'))
    try {
      const { session, manager, faux } = await fixture(directory)
      const projection = new ConversationProjection()
      const history = new SessionHistoryController(projection)
      const exits: (() => void)[] = []
      const safeErrors: string[] = []
      const quarantine = new DisplayFailureQuarantine(
        (exit) => exits.push(exit),
        (message) => safeErrors.push(message)
      )
      let callbacks = 0
      history.connect(session, 1, {
        quarantine,
        onEvent: (event) => {
          callbacks++
          if (event.type === 'message_start') throw new Error('private-secret')
        },
        onCommitted: () => {
          throw new Error('must never publish after latch')
        }
      })
      faux.setResponses([fauxAssistantMessage('healthy SDK completion')])
      await expect(session.prompt('question')).resolves.toBeUndefined()
      const countAtFailure = callbacks
      quarantine.run(() => callbacks++)
      expect(callbacks).toBe(countAtFailure)
      expect(exits).toHaveLength(1)
      expect(
        manager
          .getBranch()
          .filter((entry) => entry.type === 'message')
          .map((entry) => entry.type === 'message' && entry.message.role)
      ).toEqual(['user', 'assistant'])
      expect(
        manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === 'message' &&
              entry.message.role === 'assistant' &&
              entry.message.stopReason === 'error'
          )
      ).toBe(false)
      exits[0]()
      expect(safeErrors).toEqual(['会话显示更新失败，请重新连接'])
      // This lifecycle fixture must not start file-credential work that can race
      // its cleanup; credential persistence is covered by separate SDK tests.
      expect(existsSync(join(directory, 'agent', 'auth.json'))).toBe(false)
      // Fixture cleanup only. Production quarantine exits the process without disposal.
      session.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('publishes preappend temporary and postcore canonical history with distinct partial/final objects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-history-sdk-'))
    try {
      const { session, manager, faux } = await fixture(directory)
      const projection = new ConversationProjection()
      const history = new SessionHistoryController(projection)
      const failures: string[] = []
      const quarantine = new DisplayFailureQuarantine(
        (callback) => callback(),
        (message) => failures.push(message)
      )
      const partials: AssistantMessage[] = []
      let final: AssistantMessage | undefined
      const ends: string[] = []
      history.connect(session, 1, {
        quarantine,
        onEvent: (event) => {
          if (event.type === 'message_update' && event.message.role === 'assistant') {
            partials.push(event.message)
            history.update(event.message)
          }
          if (event.type === 'message_end') {
            expect(
              manager
                .getBranch()
                .some((entry) => entry.type === 'message' && entry.message === event.message)
            ).toBe(false)
            expect(projection.view().at(-1)?.id).toMatch(/^temporary:/)
            if (event.message.role === 'assistant') final = event.message
            ends.push(event.message.role)
          }
        },
        onCommitted: () => {
          expect(projection.view().every((node) => node.id.startsWith('entry:'))).toBe(true)
        }
      })
      faux.setResponses([
        fauxAssistantMessage('streamed answer with several deltas', { timestamp: 10 })
      ])
      await session.prompt('first question')
      expect(failures).toEqual([])
      expect(ends).toEqual(['user', 'assistant'])
      expect(partials.length).toBeGreaterThan(1)
      expect(partials.every((partial) => partial !== final)).toBe(true)
      const identities = projection.view().map((node) => node.id)
      let reboundEvents = 0
      history.connect(session, 2, {
        quarantine,
        onEvent: () => {
          reboundEvents++
        },
        onCommitted: () => {}
      })
      expect(projection.view().map((node) => node.id)).toEqual(identities)
      faux.setResponses([fauxAssistantMessage('new generation')])
      await session.prompt('rebound question')
      expect(reboundEvents).toBeGreaterThan(0)
      expect(ends).toEqual(['user', 'assistant'])
      const reboundIdentities = projection.view().map((node) => node.id)
      expect(reboundIdentities.slice(0, identities.length)).toEqual(identities)
      history.detach()
      faux.setResponses([fauxAssistantMessage('unsubscribed')])
      await session.prompt('later question')
      expect(projection.view().map((node) => node.id)).toEqual(reboundIdentities)
      session.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
