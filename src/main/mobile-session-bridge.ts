import type {
  AgentSnapshot,
  ApprovalRequest,
  ConversationNode,
  PermissionMode,
  PromptImage
} from '../shared/contracts'
import type { CheckpointPlan, CheckpointRestoreOutcome } from '../shared/checkpoints'
import type { SkillSummary } from '../shared/skills'
import type {
  MobileCatalogProject,
  MobileConversationSnapshot,
  MobileSessionListItem
} from '../shared/mobile-gateway'
import { liveSessionToMobile } from '../shared/mobile-gateway'
import type { LiveSessionSummary } from '../shared/session-runtime'

export type MobileIdentity = { sessionId: string; generation: number }

export type MobileSessionBridge = {
  listLive(): MobileSessionListItem[]
  listCatalog(): Promise<MobileCatalogProject[]>
  snapshot(workerId: string): MobileConversationSnapshot | null
  /** Without a session path this starts a new session, optionally on a given model. */
  open(
    cwd: string,
    sessionPath?: string,
    model?: { providerId: string; modelId: string }
  ): Promise<MobileConversationSnapshot>
  send(
    workerId: string,
    text: string,
    sessionId: string,
    generation: number,
    images?: PromptImage[]
  ): Promise<void>
  setModel(
    workerId: string,
    identity: MobileIdentity,
    providerId: string,
    modelId: string
  ): Promise<void>
  setPermission(workerId: string, mode: PermissionMode): Promise<void>
  skills(workerId: string, identity: MobileIdentity): Promise<SkillSummary[]>
  checkpointPlan(
    workerId: string,
    identity: MobileIdentity,
    entryId: string
  ): Promise<CheckpointPlan | null>
  checkpointRestore(
    workerId: string,
    identity: MobileIdentity,
    entryId: string,
    force: boolean
  ): Promise<CheckpointRestoreOutcome | null>
  abort(workerId: string): Promise<void>
  clearQueue(workerId: string): Promise<void>
  respond(workerId: string, approvalId: string, allow: boolean): Promise<void>
  subscribe(
    listener: (event: {
      workerId: string
      snapshot: MobileConversationSnapshot
      runFinished: boolean
    }) => void
  ): () => void
}

const MOBILE_NODE_LIMIT = 200

function titleFrom(snapshot: AgentSnapshot, fallback: string): string {
  const active = snapshot.sessions.find((session) => session.path === snapshot.activeSessionPath)
  if (active?.title) return active.title.slice(0, 200)
  const user = snapshot.nodes.find((node) => node.type === 'user')
  if (user?.type === 'user' && user.text) return user.text.slice(0, 200)
  return fallback
}

export function toMobileSnapshot(
  workerId: string,
  cwd: string,
  snapshot: AgentSnapshot
): MobileConversationSnapshot {
  const nodes: ConversationNode[] =
    snapshot.nodes.length > MOBILE_NODE_LIMIT
      ? snapshot.nodes.slice(-MOBILE_NODE_LIMIT)
      : snapshot.nodes
  return {
    workerId,
    cwd,
    title: titleFrom(snapshot, '会话'),
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    status: snapshot.status,
    busy: snapshot.busy,
    approvals: snapshot.approvals satisfies ApprovalRequest[],
    followUp: snapshot.followUp,
    queuedCount: snapshot.queuedCount,
    composeBlockReason: snapshot.composeBlockReason,
    model: snapshot.activeModel,
    provider: snapshot.activeProvider,
    models: snapshot.models.slice(0, 100).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      image: Boolean(model.input?.includes('image')),
      ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {})
    })),
    permissionMode: snapshot.permissionMode,
    ...(snapshot.checkpoints ? { checkpoints: snapshot.checkpoints } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    nodes
  }
}

export function liveToMobile(sessions: LiveSessionSummary[]): MobileSessionListItem[] {
  return sessions.map(liveSessionToMobile)
}
