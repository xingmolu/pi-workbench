import { create } from 'zustand'
import { AGENT_ENGINE, type AgentSnapshot, type AgentStatePatch } from '../../../shared/contracts'
import { applyStatePatch, type ApplyStatePatchResult } from '../../../shared/state-patch'
import type { CustomEndpointContext } from '../../../shared/custom-endpoints'
import {
  sameSelectedScope,
  type DesktopCommandOrigin,
  type LiveSessionSummary
} from '../../../shared/session-runtime'

export function commandOrigin(snapshot: AgentSnapshot): DesktopCommandOrigin | undefined {
  return snapshot.desktopScope
    ? {
        scope: snapshot.desktopScope,
        sessionId: snapshot.sessionId,
        generation: snapshot.generation
      }
    : undefined
}

/** The form captures this identity; credentials never enter the shared store. */
export function endpointContext(snapshot: AgentSnapshot): CustomEndpointContext {
  return {
    projectPath: snapshot.project?.path ?? null,
    sessionId: snapshot.sessionId,
    generation: snapshot.generation
  }
}

export const EMPTY_SNAPSHOT: AgentSnapshot = {
  sessionId: null,
  generation: 0,
  revision: 0,
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
  modelAvailability: 'unselected',
  composeBlockReason: 'project-required',
  busy: false,
  status: 'idle',
  approvals: [],
  followUp: [],
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
  login: { phase: 'idle' },
  loginPrompt: null
}

type PiStore = {
  liveSessions: LiveSessionSummary[]
  setLiveSessions: (sessions: LiveSessionSummary[]) => void
  snapshot: AgentSnapshot
  loading: boolean
  clientError: string | null
  disconnected: boolean
  forkPending: string | null
  setForkPending: (identity: string | null) => void
  disconnect: (message: string) => void
  recover: (snapshot: AgentSnapshot) => void
  setSnapshot: (snapshot: AgentSnapshot) => void
  applyPatch: (patch: AgentStatePatch) => ApplyStatePatchResult['status']
  setLoading: (loading: boolean) => void
  setClientError: (message: string | null) => void
}

export const usePiStore = create<PiStore>((set) => ({
  liveSessions: [],
  setLiveSessions: (liveSessions) => set({ liveSessions }),
  snapshot: EMPTY_SNAPSHOT,
  loading: true,
  clientError: null,
  disconnected: false,
  forkPending: null,
  setForkPending: (forkPending) => set({ forkPending }),
  disconnect: (message) =>
    set((state) => ({
      disconnected: true,
      loading: false,
      clientError: message,
      snapshot: { ...state.snapshot, ready: false, busy: false, approvals: [] }
    })),
  recover: (snapshot) => set({ snapshot, disconnected: false, loading: false, clientError: null }),
  setSnapshot: (snapshot) =>
    set((state) => {
      const current = state.snapshot
      const incoming = snapshot.desktopScope
      const selected = current.desktopScope
      const currentEpoch = selected?.selectionEpoch ?? current.desktopEpoch ?? 0
      const incomingEpoch = incoming?.selectionEpoch ?? snapshot.desktopEpoch ?? 0
      if (incomingEpoch < currentEpoch) return state
      if (snapshot.desktopEpoch !== undefined && !incoming && incomingEpoch > currentEpoch)
        return { snapshot, disconnected: false, loading: false, clientError: null }
      if (
        state.disconnected &&
        !(
          snapshot.ready &&
          incoming &&
          selected &&
          incoming.selectionEpoch > selected.selectionEpoch
        )
      )
        return state
      if (
        selected &&
        (!incoming ||
          incoming.selectionEpoch < selected.selectionEpoch ||
          (incoming.selectionEpoch === selected.selectionEpoch &&
            incoming.workerId !== selected.workerId))
      )
        return state
      if (incoming && (!selected || incoming.selectionEpoch > selected.selectionEpoch))
        return { snapshot, disconnected: false, loading: false, clientError: null }
      if (
        snapshot.generation < current.generation ||
        (snapshot.generation === current.generation &&
          snapshot.sessionId === current.sessionId &&
          snapshot.revision < current.revision)
      ) {
        return state
      }
      return { snapshot, loading: false, clientError: null }
    }),
  applyPatch: (patch) => {
    let status: ApplyStatePatchResult['status'] = 'ignored'
    set((state) => {
      if (state.disconnected) return state
      const selected = state.snapshot.desktopScope
      const incoming = patch.meta.desktopScope
      const currentEpoch = selected?.selectionEpoch ?? state.snapshot.desktopEpoch ?? 0
      const incomingEpoch = incoming?.selectionEpoch ?? patch.meta.desktopEpoch ?? 0
      if (incomingEpoch < currentEpoch) return state
      if (incomingEpoch > currentEpoch) { status = 'needsSnapshot'; return state }
      if (selected && !sameSelectedScope(selected, incoming ?? null)) {
        status =
          incoming && incoming.selectionEpoch > selected.selectionEpoch
            ? 'needsSnapshot'
            : 'ignored'
        return state
      }
      const result = applyStatePatch(state.snapshot, patch)
      status = result.status
      return result.status === 'applied'
        ? { snapshot: result.snapshot, loading: false, clientError: null }
        : state
    })
    return status
  },
  setLoading: (loading) => set({ loading }),
  setClientError: (clientError) => set({ clientError, loading: false })
}))
