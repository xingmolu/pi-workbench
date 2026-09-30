import type { AgentSnapshot } from './contracts'

/** The public projection before an adapter has connected; SDKs fill their own metadata. */
export function createEmptyAgentSnapshot(engine: string, agentDir: string): AgentSnapshot {
  return {
    sessionId: null,
    generation: 0,
    revision: 0,
    ready: false,
    engine,
    agentDir,
    project: null,
    sessions: [],
    activeSessionPath: null,
    nodes: [],
    accounts: [],
    models: [],
    activeProvider: null,
    activeModel: null,
    modelAvailability: 'unselected',
    composeBlockReason: 'project-required',
    busy: false,
    status: 'idle',
    approvals: [],
    followUp: [],
    queuedCount: 0,
    permissionMode: 'ask',
    metrics: { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    login: { phase: 'idle' },
    loginPrompt: null
  }
}
