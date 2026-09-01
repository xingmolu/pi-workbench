import { create } from 'zustand'
import {
  AGENT_ENGINE,
  type AgentSnapshot,
  type ApprovalRequest,
  type LoginPrompt
} from '../../../shared/contracts'

export const EMPTY_SNAPSHOT: AgentSnapshot = {
  ready: false,
  engine: AGENT_ENGINE,
  agentDir: '~/.pi/agent',
  project: null,
  sessions: [],
  activeSessionPath: null,
  nodes: [],
  accounts: [],
  models: [],
  activeProvider: null,
  activeModel: null,
  busy: false,
  queuedCount: 0,
  permissionMode: 'ask',
  metrics: {
    turns: 0,
    steps: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  },
  login: { phase: 'idle' }
}

type PiStore = {
  snapshot: AgentSnapshot
  approval: ApprovalRequest | null
  loginPrompt: LoginPrompt | null
  loading: boolean
  clientError: string | null
  setSnapshot: (snapshot: AgentSnapshot) => void
  setApproval: (approval: ApprovalRequest | null) => void
  setLoginPrompt: (prompt: LoginPrompt | null) => void
  setLoading: (loading: boolean) => void
  setClientError: (message: string | null) => void
}

export const usePiStore = create<PiStore>((set) => ({
  snapshot: EMPTY_SNAPSHOT,
  approval: null,
  loginPrompt: null,
  loading: true,
  clientError: null,
  setSnapshot: (snapshot) => set({ snapshot, loading: false, clientError: null }),
  setApproval: (approval) => set({ approval }),
  setLoginPrompt: (loginPrompt) => set({ loginPrompt }),
  setLoading: (loading) => set({ loading }),
  setClientError: (clientError) => set({ clientError, loading: false })
}))
