import { describe, expect, it } from 'vitest'
import {
  AGENT_ENGINE,
  type AgentSnapshot,
  type ConversationNode,
  type HostCommand
} from './contracts'
import {
  agentSnapshotSchema,
  hostCommandSchema,
  hostMessageSchema,
  hostRequestSchema
} from './schemas'
import { applyStatePatch, diffState } from './state-patch'

function snapshot(
  nodes: ConversationNode[],
  overrides: Partial<AgentSnapshot> = {}
): AgentSnapshot {
  return {
    sessionId: 'session-a',
    generation: 3,
    revision: 7,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/tmp/.pi/agent',
    project: { path: '/tmp/project', name: 'project' },
    sessions: [],
    activeSessionPath: '/tmp/session.jsonl',
    nodes,
    accounts: [],
    models: [],
    activeProvider: 'openai-codex',
    activeModel: 'gpt-5',
    modelAvailability: 'available',
    composeBlockReason: null,
    busy: true,
    status: 'running',
    approvals: [],
    followUp: [],
    queuedCount: 0,
    permissionMode: 'ask',
    metrics: {
      turns: 1,
      steps: 0,
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0
    },
    login: { phase: 'idle' },
    loginPrompt: null,
    ...overrides
  }
}

function next(previous: AgentSnapshot, overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return { ...previous, revision: previous.revision + 1, ...overrides }
}

describe('incremental state patches', () => {
  it('updates one streaming node without replacing the other nodes', () => {
    const user: ConversationNode = { id: 'user-1', type: 'user', text: 'hello' }
    const streaming: ConversationNode = {
      id: 'assistant-1',
      type: 'assistant',
      markdown: 'hel',
      streaming: true
    }
    const previous = snapshot([user, streaming])
    const completed = next(previous, {
      nodes: [user, { ...streaming, markdown: 'hello' }]
    })

    const patch = diffState(previous, completed)

    expect(patch.nodeUpserts).toEqual([
      { id: 'assistant-1', type: 'assistant', markdown: 'hello', streaming: true }
    ])
    expect(patch.removedNodeIds).toEqual([])
    expect(patch.nodeOrder).toBeUndefined()
    expect(patch.meta).toEqual({})
    expect('nodes' in patch.meta).toBe(false)
    expect(applyStatePatch(previous, patch)).toEqual({ status: 'applied', snapshot: completed })
  })

  it('inserts and removes nodes while preserving the authoritative order', () => {
    const first: ConversationNode = { id: 'user-1', type: 'user', text: 'one' }
    const removed: ConversationNode = { id: 'think-1', type: 'think', text: 'old' }
    const last: ConversationNode = { id: 'assistant-1', type: 'assistant', markdown: 'done' }
    const inserted: ConversationNode = {
      id: 'tool-call-1',
      type: 'tool',
      toolCallId: 'call-1',
      name: 'read',
      intent: 'read',
      title: 'Read file',
      status: 'running'
    }
    const previous = snapshot([first, removed, last])
    const changed = next(previous, { nodes: [first, inserted, last] })

    const patch = diffState(previous, changed)

    expect(patch.nodeUpserts).toEqual([inserted])
    expect(patch.removedNodeIds).toEqual(['think-1'])
    expect(patch.nodeOrder).toEqual(['user-1', 'tool-call-1', 'assistant-1'])
    expect(applyStatePatch(previous, patch)).toEqual({ status: 'applied', snapshot: changed })
  })

  it('ignores duplicate and old patches idempotently', () => {
    const previous = snapshot([{ id: 'assistant-1', type: 'assistant', markdown: 'a' }])
    const changed = next(previous, {
      nodes: [{ id: 'assistant-1', type: 'assistant', markdown: 'ab' }]
    })
    const patch = diffState(previous, changed)

    expect(applyStatePatch(changed, patch)).toEqual({ status: 'ignored', snapshot: changed })
    expect(applyStatePatch(changed, { ...patch, baseRevision: 5, revision: 6 })).toEqual({
      status: 'ignored',
      snapshot: changed
    })
  })

  it('requests a snapshot for a missing revision or out-of-order future patch', () => {
    const previous = snapshot([])
    const future = snapshot([], { revision: 10, busy: false, status: 'idle' })
    const patch = diffState({ ...future, revision: 9 }, future)

    expect(applyStatePatch(previous, patch)).toEqual({
      status: 'needsSnapshot',
      snapshot: previous
    })

    expect(
      applyStatePatch(previous, {
        ...diffState(previous, next(previous, { busy: false, status: 'idle' })),
        revision: previous.revision + 2
      })
    ).toEqual({ status: 'needsSnapshot', snapshot: previous })
  })

  it('applies a completed-message correction through the stable node id', () => {
    const previous = snapshot(
      [{ id: 'assistant-42-0', type: 'assistant', markdown: 'draft', streaming: false }],
      { busy: false, status: 'idle' }
    )
    const corrected = next(previous, {
      nodes: [{ id: 'assistant-42-0', type: 'assistant', markdown: 'corrected', streaming: false }]
    })
    const patch = diffState(previous, corrected)

    expect(patch.nodeUpserts.map((node) => node.id)).toEqual(['assistant-42-0'])
    expect(patch.removedNodeIds).toEqual([])
    expect(applyStatePatch(previous, patch)).toEqual({
      status: 'applied',
      snapshot: corrected
    })
  })

  it('updates concurrent tools independently', () => {
    const first: ConversationNode = {
      id: 'tool-a',
      type: 'tool',
      toolCallId: 'a',
      name: 'read',
      intent: 'read',
      title: 'A',
      status: 'running'
    }
    const second: ConversationNode = {
      id: 'tool-b',
      type: 'tool',
      toolCallId: 'b',
      name: 'bash',
      intent: 'terminal',
      title: 'B',
      status: 'running'
    }
    const previous = snapshot([first, second])
    const changed = next(previous, {
      nodes: [
        { ...first, status: 'success', durationMs: 12 },
        { ...second, status: 'error', durationMs: 19 }
      ]
    })

    const patch = diffState(previous, changed)
    expect(patch.nodeUpserts).toHaveLength(2)
    expect(applyStatePatch(previous, patch)).toEqual({ status: 'applied', snapshot: changed })
  })

  it('requests a snapshot when the session or generation changes', () => {
    const previous = snapshot([])
    const nextSession = snapshot([], {
      sessionId: 'session-b',
      generation: 4,
      revision: 1
    })
    const patch = diffState(
      { ...nextSession, sessionId: 'session-a', generation: 3, revision: 0 },
      nextSession
    )

    expect(applyStatePatch(previous, patch)).toEqual({
      status: 'needsSnapshot',
      snapshot: previous
    })
  })

  it('validates distinct transport and approval request identifiers', () => {
    expect(
      hostRequestSchema.safeParse({
        type: 'permission:respond',
        approvalId: 'approval-1',
        allow: true,
        requestId: 'transport-1'
      }).success
    ).toBe(true)
    expect(
      hostMessageSchema.safeParse({
        type: 'event',
        event: 'approval',
        data: { id: 'approval-1' }
      }).success
    ).toBe(false)
  })

  it('requires session:new provider and model to be supplied together', () => {
    expect(hostCommandSchema.safeParse({ type: 'session:new' }).success).toBe(true)
    expect(
      hostCommandSchema.safeParse({
        type: 'session:new',
        providerId: 'openai-codex-work',
        modelId: 'gpt-5.6-sol'
      }).success
    ).toBe(true)
    expect(
      hostCommandSchema.safeParse({
        type: 'session:new',
        providerId: 'openai-codex-work'
      }).success
    ).toBe(false)
    expect(
      hostCommandSchema.safeParse({ type: 'session:new', modelId: 'gpt-5.6-sol' }).success
    ).toBe(false)

    expect(
      hostRequestSchema.safeParse({ type: 'session:new', requestId: 'new-unselected' }).success
    ).toBe(true)
    expect(
      hostRequestSchema.safeParse({
        type: 'session:new',
        providerId: 'openai-codex-work',
        modelId: 'gpt-5.6-sol',
        requestId: 'new-exact'
      }).success
    ).toBe(true)
    expect(
      hostRequestSchema.safeParse({
        type: 'session:new',
        providerId: 'openai-codex-work',
        requestId: 'new-provider-only'
      }).success
    ).toBe(false)
    expect(
      hostRequestSchema.safeParse({
        type: 'session:new',
        modelId: 'gpt-5.6-sol',
        requestId: 'new-model-only'
      }).success
    ).toBe(false)

    const bare: HostCommand = { type: 'session:new' }
    const exact: HostCommand = {
      type: 'session:new',
      providerId: 'openai-codex-work',
      modelId: 'gpt-5.6-sol'
    }
    // @ts-expect-error session:new requires provider and model together
    const providerOnly: HostCommand = {
      type: 'session:new',
      providerId: 'openai-codex-work'
    }
    // @ts-expect-error session:new requires provider and model together
    const modelOnly: HostCommand = { type: 'session:new', modelId: 'gpt-5.6-sol' }
    expect([bare, exact, providerOnly, modelOnly]).toHaveLength(4)
  })

  it('validates typed snapshot responses and every supported host event', () => {
    const state = snapshot([])
    const patch = diffState(state, next(state, { busy: false, status: 'idle' }))
    const messages = [
      {
        type: 'response',
        requestId: 'transport-1',
        ok: true,
        data: { kind: 'snapshot', snapshot: state }
      },
      {
        type: 'response',
        requestId: 'transport-2',
        ok: true,
        data: { kind: 'ack', sessionId: 'session-a', generation: 3, revision: 8 }
      },
      { type: 'event', event: 'snapshot', data: state },
      { type: 'event', event: 'patch', data: patch },
      {
        type: 'event',
        event: 'open-external',
        data: { url: 'https://auth.openai.com/' }
      }
    ]

    expect(messages.map((message) => hostMessageSchema.safeParse(message).success)).toEqual([
      true,
      true,
      true,
      true,
      true
    ])
    expect(
      hostMessageSchema.safeParse({
        type: 'event',
        event: 'login-prompt',
        data: { id: 'prompt-1' }
      }).success
    ).toBe(false)
    expect(
      hostMessageSchema.safeParse({
        type: 'response',
        requestId: 'transport-3',
        ok: true,
        data: state
      }).success
    ).toBe(false)
  })

  it('carries the authoritative login prompt through snapshot patches', () => {
    const previous = snapshot([])
    const prompt = {
      id: 'prompt-1',
      providerId: 'openai-codex',
      type: 'manual_code' as const,
      message: 'Paste the code'
    }
    const changed = next(previous, { loginPrompt: prompt })

    const patch = diffState(previous, changed)

    expect(patch.meta.loginPrompt).toEqual(prompt)
    expect(Object.keys(patch.meta)).toEqual(['loginPrompt'])
    expect(applyStatePatch(previous, patch)).toEqual({ status: 'applied', snapshot: changed })
    expect(agentSnapshotSchema.safeParse(changed).success).toBe(true)
  })

  it('requires typed model availability and composer block reasons', () => {
    const state = snapshot([], {
      modelAvailability: 'unavailable',
      composeBlockReason: 'pinned-model-unavailable'
    })

    expect(agentSnapshotSchema.safeParse(state).success).toBe(true)
    expect(agentSnapshotSchema.safeParse({ ...state, modelAvailability: 'fallback' }).success).toBe(
      false
    )
    expect(agentSnapshotSchema.safeParse({ ...state, composeBlockReason: 'unknown' }).success).toBe(
      false
    )
  })
})
