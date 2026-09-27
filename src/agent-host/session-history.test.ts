import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  SessionManager,
  buildContextEntries,
  buildSessionContext,
  type SessionEntry
} from '@earendil-works/pi-coding-agent'
import { historyNodeId, projectSessionHistory } from './session-history'

const user = (content: string) => ({ role: 'user' as const, content, timestamp: 100 })
const assistant = (
  content: AssistantMessage['content'],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-responses',
  provider: 'test',
  model: 'test',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: 100,
  ...overrides
})
const call = (id = 'reused'): AssistantMessage =>
  assistant([{ type: 'toolCall', id, name: 'bash', arguments: { command: 'pwd' } }])
const result = (text: string, id = 'reused', isError = false): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'bash',
  content: [{ type: 'text', text }],
  isError,
  timestamp: 100
})

describe('canonical active branch history', () => {
  it('projects canonical completed assistant identity and latest local feedback across text blocks only', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-fixture')
    const entryId = manager.appendMessage(assistant([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))
    manager.appendCustomEntry('pi-desktop:message-feedback', { entryId, value: 'up' })
    manager.appendCustomEntry('pi-desktop:message-feedback', { entryId, value: 'down' })
    expect(projectSessionHistory(manager.getBranch())).toMatchObject([
      { canonicalEntryId: entryId, feedback: 'down' },
      { canonicalEntryId: entryId, feedback: 'down' }
    ])
    manager.appendMessage(assistant([{ type: 'text', text: 'working' }, { type: 'toolCall', id: 't', name: 'bash', arguments: {} }], { stopReason: 'toolUse' }))
    expect(projectSessionHistory(manager.getBranch()).find(n => n.type === 'assistant' && n.markdown === 'working')).not.toHaveProperty('canonicalEntryId')
    expect(projectSessionHistory([], { temporaryMessages: [{ id: 'tmp', message: assistant([{type:'text',text:'temporary'}]) }] })[0]).not.toHaveProperty('canonicalEntryId')
  })
  it('shows proposed edits until the canonical result supplies the applied patch', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-fixture')
    manager.appendMessage(user('fix'))
    manager.appendMessage(
      assistant(
        [
          {
            type: 'toolCall',
            id: 'e',
            name: 'edit',
            arguments: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }
          }
        ],
        { stopReason: 'toolUse' }
      )
    )
    const tool = () => projectSessionHistory(manager.getBranch()).find((node) => node.type === 'tool')
    expect(tool()).toMatchObject({ change: { source: 'proposed', anchored: false, path: 'a.ts' } })
    const patch = '--- a.ts\n+++ a.ts\n@@ -7,1 +7,1 @@\n-a\n+b\n'
    manager.appendMessage({
      ...result('ok', 'e'),
      toolName: 'edit',
      details: { diff: '', patch, firstChangedLine: 7 }
    } as ToolResultMessage)
    expect(tool()).toMatchObject({
      status: 'success',
      change: { source: 'applied', anchored: true, path: 'a.ts', patch }
    })
  })
  it('projects image-only user with canonical entry identity and no image capability', () => {
    const manager = SessionManager.inMemory('/tmp/pi-history-fixture')
    const id = manager.appendMessage({
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'c2VjcmV0' }],
      timestamp: 1
    })
    expect(projectSessionHistory(manager.getBranch())).toEqual([
      {
        id: historyNodeId({ source: 'entry', id }, 'user'),
        canonicalEntryId: id,
        type: 'user',
        text: '',
        imageCount: 1
      }
    ])
  })
  it('a new assistant occurrence takes precedence over an unfinished call with the same ID', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(call())
    session.appendMessage(call())
    session.appendMessage(result('new assistant result'))
    expect(projectSessionHistory(session.getBranch())).toMatchObject([
      { status: 'queued' },
      { status: 'success', output: 'new assistant result' }
    ])
  })

  it('pairs duplicate IDs inside one assistant message with results in FIFO order', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(assistant([...call().content, ...call().content]))
    session.appendMessage(result('first result'))
    session.appendMessage(result('second result'))
    expect(projectSessionHistory(session.getBranch())).toMatchObject([
      { output: 'first result' },
      { output: 'second result' }
    ])
  })
  it('does not apply orphan results after a new user interrupts an unfinished call', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(call())
    session.appendMessage(user('new turn'))
    session.appendMessage(result('orphan after interruption'))
    expect(projectSessionHistory(session.getBranch())[0]).toMatchObject({
      type: 'tool',
      status: 'queued'
    })
    expect(projectSessionHistory(session.getBranch())[0]).not.toHaveProperty('output')
  })

  it('encodes legacy lone surrogate identities without throwing or colliding', () => {
    const malformed = '\ud800'
    const id = historyNodeId({ source: 'entry', id: malformed }, 'tool', 0, malformed)
    expect(id).not.toBe(historyNodeId({ source: 'entry', id: '\\ud800' }, 'tool', 0, '\\ud800'))
    expect(id).not.toBe(
      historyNodeId({ source: 'entry', id: '%utf16-d800' }, 'tool', 0, '%utf16-d800')
    )
    expect(id).toBe(historyNodeId({ source: 'entry', id: malformed }, 'tool', 0, malformed))
  })

  it('keeps messages around the real compaction boundary while SDK context is compressed', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    const modelId = session.appendModelChange('provider-a', 'model-a')
    const oldId = session.appendMessage(user('old question'))
    session.appendMessage(assistant([{ type: 'text', text: 'old answer' }]))
    const keptId = session.appendMessage(user('kept question'))
    const compactId = session.appendCompaction('private full compaction summary', keptId, 45000)
    session.appendModelChange('provider-b', 'model-b')
    session.appendMessage(assistant([{ type: 'text', text: 'new answer' }]))
    const branch = session.getBranch()
    const nodes = projectSessionHistory(branch)
    expect(nodes.map((node) => node.type)).toEqual([
      'model',
      'user',
      'assistant',
      'user',
      'compaction',
      'model',
      'assistant'
    ])
    expect(nodes[0]).toMatchObject({
      id: `entry:${modelId}:model`,
      provider: 'provider-a',
      modelId: 'model-a',
      initial: true
    })
    expect(nodes[5]).toMatchObject({ provider: 'provider-b', modelId: 'model-b', initial: false })
    expect(nodes[4]).toEqual({
      id: `entry:${compactId}:compaction`,
      type: 'compaction',
      tokensBefore: 45000
    })
    expect(JSON.stringify(nodes)).toContain('old question')
    expect(JSON.stringify(nodes)).not.toContain('private full compaction summary')
    expect(buildContextEntries(branch).map((entry) => entry.id)).not.toContain(oldId)
    expect(session.buildContextEntries().map((entry) => entry.id)).not.toContain(oldId)
    const context = buildSessionContext(branch)
    expect(
      context.messages.some(
        (message) => message.role === 'user' && message.content === 'old question'
      )
    ).toBe(false)
    expect(JSON.stringify(context.messages)).toContain('private full compaction summary')
  })

  it('uses getBranch so abandoned messages and tool results cannot fill active calls', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    const shared = session.appendMessage(user('shared'))
    session.appendMessage(call())
    session.appendMessage(result('abandoned result'))
    session.appendModelChange('abandoned', 'model')
    session.branch(shared)
    session.appendMessage(call())
    const nodes = projectSessionHistory(session.getBranch())
    expect(nodes.map((node) => node.type)).toEqual(['user', 'tool'])
    expect(nodes[1]).toMatchObject({ status: 'queued' })
    expect(JSON.stringify(nodes)).not.toContain('abandoned')
    expect(session.getEntries().length).toBeGreaterThan(session.getBranch().length)
  })

  it('matches repeated provider IDs by occurrence and keeps completed outputs separate', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(call())
    session.appendMessage(result('first'))
    session.appendMessage(call())
    session.appendMessage(result('second', 'reused', true))
    session.appendMessage(call())
    const tools = projectSessionHistory(session.getBranch()).filter((node) => node.type === 'tool')
    expect(tools.map((node) => [node.output, node.status])).toEqual([
      ['first', 'success'],
      ['second', 'error'],
      [undefined, 'queued']
    ])
    expect(new Set(tools.map((node) => node.id)).size).toBe(3)
    const overlaid = projectSessionHistory(session.getBranch(), {
      toolOverlays: new Map([
        [tools[2].id, { status: 'blocked', durationMs: 50, output: 'denied' }]
      ])
    }).filter((node) => node.type === 'tool')
    expect(overlaid.slice(0, 2)).toEqual(tools.slice(0, 2))
    expect(overlaid[2]).toMatchObject({ status: 'blocked', durationMs: 50, output: 'denied' })
  })

  it('aligns interleaved tool results by call ID and ignores orphan earlier results', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(result('orphan', 'a'))
    session.appendMessage(assistant([...call('a').content, ...call('b').content]))
    session.appendMessage(result('b output', 'b'))
    session.appendMessage(result('a output', 'a'))
    const tools = projectSessionHistory(session.getBranch()).filter((node) => node.type === 'tool')
    expect(tools.map((node) => node.output)).toEqual(['a output', 'b output'])
  })

  it('never collides at equal timestamps, including repeated stopped/error messages', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(user('one'))
    session.appendMessage(user('two'))
    for (const stopReason of ['aborted', 'aborted', 'error', 'error'] as const) {
      session.appendMessage(
        assistant(
          [
            { type: 'thinking', thinking: 'think' },
            { type: 'text', text: 'partial' }
          ],
          { stopReason, errorMessage: 'failed' }
        )
      )
    }
    const nodes = projectSessionHistory(session.getBranch())
    expect(nodes).toHaveLength(14)
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length)
    expect(nodes.filter((node) => node.type === 'stopped')).toHaveLength(2)
    expect(nodes.filter((node) => node.type === 'error')).toHaveLength(2)
    expect(projectSessionHistory(session.getBranch())).toEqual(nodes)
  })

  it('omits unsupported entries and tolerates empty, null and missing legacy content', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendCustomEntry('state', { role: 'assistant', content: 'not an answer' })
    session.appendCustomMessageEntry('extension', 'not a user', true)
    session.appendMessage(user(''))
    session.appendMessage(assistant([]))
    const branch: SessionEntry[] = session.getBranch()
    // Legacy JSON data may predate the SDK type guarantees.
    for (const content of [null, undefined]) {
      for (const message of [user(''), assistant([])]) {
        branch.push(
          JSON.parse(
            JSON.stringify({
              type: 'message',
              id: `legacy-${message.role}-${String(content)}`,
              parentId: null,
              timestamp: '',
              message: { ...message, content }
            })
          )
        )
      }
    }
    branch.push({
      type: 'branch_summary',
      id: 'summary',
      parentId: null,
      timestamp: '',
      fromId: 'old',
      summary: 'not an assistant'
    })
    expect(projectSessionHistory(branch)).toEqual([])
  })

  it('caps tool output while preserving actual length, error and scoped duration', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(call())
    session.appendMessage(result('x'.repeat(13000), 'reused', true))
    const tool = projectSessionHistory(session.getBranch())[0]
    expect(tool).toMatchObject({
      output: 'x'.repeat(12000),
      originalOutputLength: 13000,
      truncated: true,
      status: 'error'
    })
    expect(tool).not.toHaveProperty('durationMs')
    expect(tool).not.toHaveProperty('cost')
  })

  it('projects temporary messages with supplied identity and freezes canonical inputs safely', () => {
    const session = SessionManager.inMemory('/tmp/pi-history-fixture')
    session.appendMessage(user('persisted'))
    const branch = session.getBranch()
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze)
        Object.freeze(value)
      }
    }
    freeze(branch)
    const live = assistant([{ type: 'text', text: 'streaming' }])
    freeze(live)
    const before = JSON.stringify(branch)
    const nodes = projectSessionHistory(branch, {
      temporaryMessages: [{ id: 'generation-1-message-1', message: live, streaming: true }]
    })
    expect(nodes[1]).toEqual({
      id: 'temporary:generation-1-message-1:assistant:0',
      presentationIdentity: 'presentation:generation-1-message-1:assistant:0',
      type: 'assistant',
      markdown: 'streaming',
      streaming: true
    })
    expect(JSON.stringify(branch)).toBe(before)
    expect(projectSessionHistory([])).toEqual([])
  })
})
