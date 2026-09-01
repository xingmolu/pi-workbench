import { describe, expect, it, vi } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot } from '../shared/contracts'
import { buildStreamingPatch } from './streaming-patch'

function snapshot(): AgentSnapshot {
  return {
    sessionId: 'session-1',
    generation: 2,
    revision: 8,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/tmp/agent',
    project: { path: '/tmp/project', name: 'project' },
    sessions: [],
    activeSessionPath: '/tmp/session.jsonl',
    nodes: [{ id: 'assistant-1-0', type: 'assistant', markdown: 'a', streaming: true }],
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
    metrics: { turns: 1, steps: 0, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    login: { phase: 'idle' },
    loginPrompt: null
  }
}

describe('buildStreamingPatch', () => {
  it('uses cached metadata and never invokes durable session projection for a token batch', () => {
    const previous = snapshot()
    const buildDurableSnapshot = vi.fn<() => AgentSnapshot>()
    const node = {
      id: 'assistant-1-0',
      type: 'assistant' as const,
      markdown: 'ab',
      streaming: true
    }

    const result = buildStreamingPatch({
      previous,
      sessionId: 'session-1',
      generation: 2,
      nodes: [node],
      changes: { nodeUpserts: [node], removedNodeIds: [] },
      buildDurableSnapshot
    })

    expect(result.kind).toBe('patch')
    if (result.kind !== 'patch') throw new Error('expected patch')
    expect(result.patch.meta).toEqual({})
    expect(result.snapshot.metrics).toBe(previous.metrics)
    expect(result.snapshot.sessions).toBe(previous.sessions)
    expect(buildDurableSnapshot).not.toHaveBeenCalled()
  })
})
