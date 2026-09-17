import type { AgentSnapshot, ApprovalRequest, ConversationNode } from '../shared/contracts'
import type {
  MobileCatalogProject,
  MobileConversationSnapshot,
  MobileSessionListItem
} from '../shared/mobile-gateway'
import { liveSessionToMobile } from '../shared/mobile-gateway'
import type { LiveSessionSummary } from '../shared/session-runtime'

export type MobileSessionBridge = {
  listLive(): MobileSessionListItem[]
  listCatalog(): Promise<MobileCatalogProject[]>
  snapshot(workerId: string): MobileConversationSnapshot | null
  open(cwd: string, sessionPath?: string): Promise<MobileConversationSnapshot>
  send(workerId: string, text: string, sessionId: string, generation: number): Promise<void>
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
    ...(snapshot.error ? { error: snapshot.error } : {}),
    nodes
  }
}

export function liveToMobile(sessions: LiveSessionSummary[]): MobileSessionListItem[] {
  return sessions.map(liveSessionToMobile)
}
