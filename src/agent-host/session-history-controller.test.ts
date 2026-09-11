import { describe, expect, it, vi } from 'vitest'
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent
} from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai'
import { agentStatePatchSchema } from '../shared/schemas'
import { ConversationProjection } from './conversation-projection'
import {
  DisplayFailureQuarantine,
  SessionHistoryController,
  HistoryModelObserver
} from './session-history-controller'

describe('live canonical history', () => {
  it('keeps bounded presentation keys through commit and refresh, with unique repeated tools and branch/detach cleanup', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-presentation')
    const anchor = manager.appendMessage({ role: 'user', content: 'anchor', timestamp: 10 })
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    const longId = 'provider-id'.repeat(200)
    const present = () => projection.view().filter((n) => n.type === 'think' || n.type === 'tool')
    const complete = () => {
      const message = fauxAssistantMessage(
        [fauxThinking('thought'), fauxToolCall('write', {}, { id: longId })],
        { timestamp: 10 }
      )
      history.start(message)
      const temporary = present().slice(-2)
      expect(
        temporary.every((n) => n.presentationIdentity && n.presentationIdentity.length <= 1024)
      ).toBe(true)
      history.end(message)
      const entryId = manager.appendMessage(message)
      history.committed(message)
      expect(
        present()
          .slice(-2)
          .map((n) => n.presentationIdentity)
      ).toEqual(temporary.map((n) => n.presentationIdentity))
      history.refresh()
      expect(
        present()
          .slice(-2)
          .map((n) => n.presentationIdentity)
      ).toEqual(temporary.map((n) => n.presentationIdentity))
      expect(
        agentStatePatchSchema.safeParse({
          sessionId: manager.getSessionId(),
          generation: 1,
          baseRevision: 0,
          revision: 1,
          nodeUpserts: projection.view(),
          removedNodeIds: [],
          meta: {}
        }).success
      ).toBe(true)
      return entryId
    }
    complete()
    const latest = complete()
    expect(new Set(present().map((n) => n.presentationIdentity)).size).toBe(4)
    manager.branch(anchor)
    history.refresh()
    manager.branch(latest)
    history.refresh()
    expect(present().every((n) => n.presentationIdentity === undefined)).toBe(true)
    complete()
    history.bind(manager, 2)
    expect(present().every((n) => n.presentationIdentity === undefined)).toBe(true)
  })
  it('does not retain unsupported payloads or interrupt an active supported lifecycle', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-custom-payloads')
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    history.start(fauxAssistantMessage('partial answer'))
    let unsupportedPayloadReads = 0
    for (let index = 0; index < 100; index++) {
      const message = {
        get role(): 'custom' {
          unsupportedPayloadReads++
          return 'custom'
        },
        customType: 'fixture',
        content: `invisible ${index}`,
        display: false,
        timestamp: 10
      }
      history.start(message)
      history.end(message)
      manager.appendCustomMessageEntry(message.customType, message.content, message.display)
      history.committed(message)
    }
    unsupportedPayloadReads = 0
    history.refresh()
    expect(unsupportedPayloadReads).toBe(0)
    const final = fauxAssistantMessage('complete answer')
    history.end(final)
    manager.appendMessage(final)
    history.committed(final)
    expect(projection.view()).toHaveLength(1)
    expect(projection.view()[0]).toMatchObject({ markdown: 'complete answer', streaming: false })
    expect(projection.view()[0].id).toMatch(/^entry:/)
  })

  it('ignores canceled generation tool events whose ID is reused by the current awaiting tool', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-stale-tool')
    const publicCallbacks: Parameters<AgentSession['subscribe']>[0][] = []
    let unsubscribed = 0
    // Public subscription transport fake retains callbacks to model already queued delivery.
    const session = {
      sessionManager: manager,
      subscribe: (callback: Parameters<AgentSession['subscribe']>[0]) => {
        publicCallbacks.push(callback)
        return () => {
          unsubscribed++
        }
      },
      agent: {
        subscribe: (_callback: Parameters<AgentSession['agent']['subscribe']>[0]) => () => {
          unsubscribed++
        }
      }
    }
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    const quarantine = new DisplayFailureQuarantine(
      (exit) => exit(),
      () => {}
    )
    let staleCallbacks = 0
    history.connect(session, 1, {
      quarantine,
      onCommitted: () => {},
      onEvent: () => {
        staleCallbacks++
        history.updateTool('reused', { status: 'error', output: 'stale output' })
      }
    })
    const oldMessage = fauxAssistantMessage(fauxToolCall('bash', {}, { id: 'reused' }))
    history.start(oldMessage)
    history.end(oldMessage)
    manager.appendMessage(oldMessage)
    history.committed(oldMessage)
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'reused',
      toolName: 'bash',
      content: [{ type: 'text', text: 'historical output' }],
      isError: false,
      timestamp: 10
    })
    history.refresh()
    history.connect(session, 2, { quarantine, onCommitted: () => {}, onEvent: () => {} })
    expect(unsubscribed).toBe(2)
    const currentMessage = fauxAssistantMessage(fauxToolCall('bash', {}, { id: 'reused' }))
    history.start(currentMessage)
    history.end(currentMessage)
    manager.appendMessage(currentMessage)
    history.committed(currentMessage)
    history.updateTool('reused', {
      status: 'awaiting-approval',
      output: 'current output',
      durationMs: 7
    })
    const before = structuredClone(projection.view())
    const events: AgentSessionEvent[] = [
      { type: 'tool_execution_start', toolCallId: 'reused', toolName: 'bash', args: {} },
      {
        type: 'tool_execution_update',
        toolCallId: 'reused',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'stale partial' }] }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'reused',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'stale final' }] },
        isError: true
      }
    ]
    for (const event of events) publicCallbacks[0](event)
    expect(staleCallbacks).toBe(0)
    expect(projection.view()).toEqual(before)
    expect(projection.view()).toMatchObject([
      { status: 'success', output: 'historical output' },
      { status: 'awaiting-approval', output: 'current output', durationMs: 7 }
    ])
  })

  it('finalizes each lifecycle when one final object is reused after distinct partial starts', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-final-reuse')
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    const final = fauxAssistantMessage('final answer', { timestamp: 10 })
    const ids: string[] = []
    for (const text of ['first partial', 'second partial']) {
      const partial = fauxAssistantMessage(text, { timestamp: 10 })
      history.start(partial)
      if (ids.length) {
        history.update(final)
        expect(projection.view().at(-1)).toMatchObject({ markdown: text, streaming: true })
      }
      history.end(final)
      expect(projection.view().at(-1)).toMatchObject({ markdown: 'final answer', streaming: false })
      ids.push(manager.appendMessage(final))
      history.committed(final)
      history.update(partial)
    }
    expect(projection.view().map((node) => node.id)).toEqual(
      ids.map((id) => `entry:${id}:assistant:0`)
    )
  })

  it('treats repeated uses of the same object as separate lifecycle occurrences', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-object-reuse')
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    const message = { role: 'user' as const, content: 'repeat', timestamp: 10 }
    const ids: string[] = []
    for (let index = 0; index < 2; index++) {
      history.start(message)
      history.end(message)
      ids.push(manager.appendMessage(message))
      history.committed(message)
    }
    expect(projection.view().map((node) => node.id)).toEqual(ids.map((id) => `entry:${id}:user`))
  })

  it('never adopts an older canonical message through equal timestamps or content', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-synthetic')
    const message = { role: 'user' as const, content: 'same', timestamp: 10 }
    manager.appendMessage({ ...message })
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    history.start(message)
    history.end(message)
    history.committed(message)
    expect(projection.view()).toHaveLength(2)
    expect(projection.view()[1].id).toMatch(/^temporary:/)
    history.bind(manager, 2)
    expect(projection.view()).toHaveLength(1)
    history.updateTool('old-generation', { status: 'running' })
    expect(projection.view()).toHaveLength(1)
  })
  it('schedules one exit even when a nested display failure makes its caller fail too', () => {
    const exits: (() => void)[] = []
    const quarantine = new DisplayFailureQuarantine(
      (exit) => exits.push(exit),
      () => {}
    )
    expect(() =>
      quarantine.run(() => {
        quarantine.run(() => {
          throw new Error('inner')
        })
        throw new Error('outer')
      })
    ).not.toThrow()
    expect(exits).toHaveLength(1)
  })
  it('does not regress a final message when an older batched partial arrives late', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-late')
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    const partial = fauxAssistantMessage('partial', { timestamp: 5 })
    const final = fauxAssistantMessage('partial with final suffix', { timestamp: 5 })
    history.start(partial)
    history.end(final)
    history.update(partial)
    expect(projection.view()[0]).toMatchObject({
      markdown: 'partial with final suffix',
      streaming: false
    })
    manager.appendMessage(final)
    history.committed(final)
    history.update(partial)
    expect(projection.view()).toHaveLength(1)
    expect(projection.view()[0]).toMatchObject({
      markdown: 'partial with final suffix',
      streaming: false
    })
    expect(projection.view()[0].id).toMatch(/^entry:/)
  })

  it('updates tokens incrementally without reading or replacing long canonical history', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-long')
    for (let index = 0; index < 2000; index++)
      manager.appendMessage({ role: 'user', content: `history ${index}`, timestamp: 1 })
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    history.start(fauxAssistantMessage('hello'))
    projection.drainChanges()
    const getBranch = vi.spyOn(manager, 'getBranch')
    history.update(fauxAssistantMessage('hello world'))
    const changes = projection.drainChanges()
    expect(getBranch).not.toHaveBeenCalled()
    expect(changes.nodeUpserts).toHaveLength(1)
    expect(changes.nodeUpserts[0]).toMatchObject({ markdown: 'hello world', streaming: true })
    expect(changes.removedNodeIds).toEqual([])
    expect(changes.nodeOrder).toBeUndefined()
    expect(projection.view()).toHaveLength(2001)
  })
  it('preserves current tool approval, bounded output metadata, and duration through migration', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-tools')
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    const partial = fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }, { id: 'same' }))
    history.start(partial)
    history.updateTool('same', {
      status: 'awaiting-approval',
      output: 'x'.repeat(12000),
      originalOutputLength: 13000,
      truncated: true,
      durationMs: 7
    })
    const final = { ...partial }
    history.end(final)
    manager.appendMessage(final)
    history.committed(final)
    expect(projection.view()[0]).toMatchObject({
      status: 'awaiting-approval',
      originalOutputLength: 13000,
      truncated: true,
      durationMs: 7
    })
    history.updateTool('same', { status: 'running' })
    history.updateTool('same', {
      status: 'success',
      output: 'done',
      originalOutputLength: 4,
      truncated: false,
      durationMs: 10
    })
    history.refresh()
    expect(projection.view()[0]).toMatchObject({
      status: 'success',
      output: 'done',
      durationMs: 10
    })
    history.start({ ...partial })
    expect(projection.view().at(-1)).toMatchObject({ status: 'queued' })
    expect(projection.view().at(-1)).not.toHaveProperty('durationMs')
    history.updateTool('same', { status: 'awaiting-approval' })
    expect(projection.view()[0]).toMatchObject({ status: 'success' })
    expect(projection.view().at(-1)).toMatchObject({ status: 'awaiting-approval' })
  })
  it('accepts only the captured manager and generation, including same-ID replacement', () => {
    const first = { getSessionId: () => 'same-id' }
    const second = { getSessionId: () => 'same-id' }
    let target = { manager: first, generation: 1 }
    let scheduled = 0
    const observer = new HistoryModelObserver(
      () => target,
      () => scheduled++
    )
    observer.observe(() => first)
    target = { manager: second, generation: 2 }
    expect(observer.take()).toBe(false)
    observer.observe(() => {
      throw new Error('inactive context')
    })
    observer.observe(() => first)
    expect(observer.take()).toBe(false)
    observer.observe(() => second)
    expect(observer.take()).toBe(true)
    expect(observer.take()).toBe(false)
    expect(scheduled).toBe(2)
  })
  it('quarantines display errors without throwing into core and cancels subsequent callbacks', () => {
    const boundary: (() => void)[] = []
    const errors: string[] = []
    const quarantine = new DisplayFailureQuarantine(
      (exit) => boundary.push(exit),
      (message) => errors.push(message)
    )
    let published = 0
    expect(() =>
      quarantine.run(() => {
        throw new Error('secret-token')
      })
    ).not.toThrow()
    quarantine.run(() => published++)
    quarantine.run(() => {
      throw new Error('recursive')
    })
    expect(quarantine.failed).toBe(true)
    expect(boundary).toHaveLength(1)
    expect(errors).toEqual([])
    boundary[0]()
    expect(errors).toEqual(['会话显示更新失败，请重新连接'])
    expect(published).toBe(0)
    expect(() => quarantine.assertHealthy()).toThrow('会话显示更新失败，请重新连接')
  })
  it('keeps preappend messages visible and atomically adopts exact canonical entries', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-controller')
    const projection = new ConversationProjection()
    const history = new SessionHistoryController(projection)
    history.bind(manager, 1)
    const first = { role: 'user' as const, content: 'first', timestamp: 10 }
    history.start(first)
    history.end(first)
    const temporaryId = projection.view()[0].id
    const presentationIdentity = projection.view()[0].presentationIdentity
    expect(temporaryId).toMatch(/^temporary:/)
    projection.drainChanges()
    const entryId = manager.appendMessage(first)
    history.committed(first)
    expect(projection.view()).toEqual([
      {
        id: `entry:${entryId}:user`,
        canonicalEntryId: entryId,
        presentationIdentity,
        type: 'user',
        text: 'first'
      }
    ])
    expect(projection.drainChanges()).toEqual({
      removedNodeIds: [temporaryId],
      nodeUpserts: [
        {
          id: `entry:${entryId}:user`,
          canonicalEntryId: entryId,
          presentationIdentity,
          type: 'user',
          text: 'first'
        }
      ],
      nodeOrder: [`entry:${entryId}:user`]
    })
    const second = { ...first, content: 'second' }
    history.start(second)
    history.end(second)
    manager.appendMessage(second)
    history.committed(second)
    expect(projection.view().map((node) => node.type === 'user' && node.text)).toEqual([
      'first',
      'second'
    ])
  })
})
