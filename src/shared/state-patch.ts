import type {
  AgentSnapshot,
  AgentSnapshotMeta,
  AgentStatePatch,
  ConversationNode
} from './contracts'

export type ApplyStatePatchResult =
  | { status: 'applied'; snapshot: AgentSnapshot }
  | { status: 'ignored'; snapshot: AgentSnapshot }
  | { status: 'needsSnapshot'; snapshot: AgentSnapshot }

function nodeEquals(left: ConversationNode, right: ConversationNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function snapshotMeta(snapshot: AgentSnapshot): AgentSnapshotMeta {
  const {
    sessionId: _sessionId,
    generation: _generation,
    revision: _revision,
    nodes: _nodes,
    ...meta
  } = snapshot
  void _sessionId
  void _generation
  void _revision
  void _nodes
  return meta
}

function metaValueEquals(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
}

function diffMeta(previous: AgentSnapshot, next: AgentSnapshot): Partial<AgentSnapshotMeta> {
  const previousMeta = snapshotMeta(previous)
  const nextMeta = snapshotMeta(next)
  const changed: Partial<AgentSnapshotMeta> = {}
  const keys = new Set([...Object.keys(previousMeta), ...Object.keys(nextMeta)]) as Set<
    keyof AgentSnapshotMeta
  >
  for (const key of keys) {
    if (!metaValueEquals(previousMeta[key], nextMeta[key])) {
      Object.assign(changed, { [key]: nextMeta[key] })
    }
  }
  return changed
}

export type StatePatchNodeChanges = Pick<
  AgentStatePatch,
  'nodeUpserts' | 'removedNodeIds' | 'nodeOrder'
>

export function createStatePatch(
  previous: AgentSnapshot,
  next: AgentSnapshot,
  changes: StatePatchNodeChanges
): AgentStatePatch {
  return {
    sessionId: next.sessionId,
    generation: next.generation,
    baseRevision: previous.revision,
    revision: next.revision,
    nodeUpserts: changes.nodeUpserts,
    removedNodeIds: changes.removedNodeIds,
    ...(changes.nodeOrder ? { nodeOrder: changes.nodeOrder } : {}),
    meta: diffMeta(previous, next)
  }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function diffState(previous: AgentSnapshot, next: AgentSnapshot): AgentStatePatch {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]))
  const nextById = new Map(next.nodes.map((node) => [node.id, node]))
  const nodeUpserts = next.nodes.filter((node) => {
    const prior = previousById.get(node.id)
    return !prior || !nodeEquals(prior, node)
  })
  const removedNodeIds = previous.nodes
    .filter((node) => !nextById.has(node.id))
    .map((node) => node.id)
  const previousOrder = previous.nodes.map((node) => node.id)
  const nextOrder = next.nodes.map((node) => node.id)

  return createStatePatch(previous, next, {
    nodeUpserts,
    removedNodeIds,
    ...(!sameOrder(previousOrder, nextOrder) ? { nodeOrder: nextOrder } : {})
  })
}

export function applyStatePatch(
  snapshot: AgentSnapshot,
  patch: AgentStatePatch
): ApplyStatePatchResult {
  if (patch.sessionId !== snapshot.sessionId || patch.generation !== snapshot.generation) {
    return { status: 'needsSnapshot', snapshot }
  }
  if (patch.revision <= snapshot.revision) return { status: 'ignored', snapshot }
  if (patch.baseRevision !== snapshot.revision || patch.revision !== patch.baseRevision + 1) {
    return { status: 'needsSnapshot', snapshot }
  }

  const removed = new Set(patch.removedNodeIds)
  const upserts = new Map(patch.nodeUpserts.map((node) => [node.id, node]))
  let nodes = snapshot.nodes
    .filter((node) => !removed.has(node.id))
    .map((node) => upserts.get(node.id) ?? node)
  const existing = new Set(nodes.map((node) => node.id))
  for (const node of patch.nodeUpserts) {
    if (!existing.has(node.id)) {
      nodes.push(node)
      existing.add(node.id)
    }
  }

  if (patch.nodeOrder) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    nodes = patch.nodeOrder.flatMap((id) => {
      const node = byId.get(id)
      return node ? [node] : []
    })
  }

  return {
    status: 'applied',
    snapshot: {
      sessionId: patch.sessionId,
      generation: patch.generation,
      revision: patch.revision,
      ...snapshotMeta(snapshot),
      ...patch.meta,
      nodes
    }
  }
}
