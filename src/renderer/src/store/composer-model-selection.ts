import type { AgentSnapshot, HostCommand } from '../../../shared/contracts'

export type ComposerModelSelectionState = {
  generation: number
  sessionId: string | null
  stagedProvider: string | null
}

export type ComposerModelSelectionAction =
  | { type: 'provider:stage'; providerId: string }
  | {
      type: 'snapshot:sync'
      generation: number
      sessionId: string | null
      activeProvider: string | null
    }

type SnapshotIdentity = Pick<AgentSnapshot, 'generation' | 'sessionId' | 'activeProvider'>
type SnapshotTranscript = Pick<AgentSnapshot, 'nodes' | 'sessions' | 'activeSessionPath'>
type SnapshotActiveModel = Pick<
  AgentSnapshot,
  'activeProvider' | 'activeModel' | 'modelAvailability'
>

export function initialComposerModelSelection(
  snapshot: SnapshotIdentity
): ComposerModelSelectionState {
  return {
    generation: snapshot.generation,
    sessionId: snapshot.sessionId,
    stagedProvider: snapshot.activeProvider
  }
}

export function composerModelSelectionReducer(
  state: ComposerModelSelectionState,
  action: ComposerModelSelectionAction
): ComposerModelSelectionState {
  if (action.type === 'provider:stage') {
    return { ...state, stagedProvider: action.providerId }
  }
  if (action.generation === state.generation && action.sessionId === state.sessionId) return state
  return {
    generation: action.generation,
    sessionId: action.sessionId,
    stagedProvider: action.activeProvider
  }
}

export function sessionHasTranscript(snapshot: SnapshotTranscript): boolean {
  if (snapshot.nodes.some((node) => node.type === 'user')) return true
  return Boolean(
    snapshot.sessions.find((session) => session.path === snapshot.activeSessionPath)?.messageCount
  )
}

export function modelSelectionCommand(
  providerId: string,
  modelId: string
): Extract<HostCommand, { type: 'model:set' }> {
  return { type: 'model:set', providerId, modelId }
}

export function newSessionCommand(
  snapshot: SnapshotActiveModel
): Extract<HostCommand, { type: 'session:new' }> {
  if (
    snapshot.modelAvailability === 'available' &&
    snapshot.activeProvider &&
    snapshot.activeModel
  ) {
    return {
      type: 'session:new',
      providerId: snapshot.activeProvider,
      modelId: snapshot.activeModel
    }
  }
  return { type: 'session:new' }
}
