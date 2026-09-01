import type { ConversationNode } from '../shared/contracts'

export type ConversationProjectionChanges = {
  nodeUpserts: ConversationNode[]
  removedNodeIds: string[]
  nodeOrder?: string[]
}

type NodeEquals = (left: ConversationNode, right: ConversationNode) => boolean

function defaultNodeEquals(left: ConversationNode, right: ConversationNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class ConversationProjection {
  private nodes: ConversationNode[] = []
  private readonly indexes = new Map<string, number>()
  private readonly groups = new Map<string, Set<string>>()
  private readonly dirtyUpserts = new Map<string, ConversationNode>()
  private readonly dirtyRemoved = new Set<string>()
  private orderDirty = false

  constructor(private readonly equals: NodeEquals = defaultNodeEquals) {}

  reset(nodes: ConversationNode[]): void {
    this.nodes = [...nodes]
    this.rebuildIndexes(0)
    this.groups.clear()
    this.dirtyUpserts.clear()
    this.dirtyRemoved.clear()
    this.orderDirty = false
  }

  view(): ConversationNode[] {
    return this.nodes
  }

  trackGroup(groupId: string, nodeIds: Iterable<string>): void {
    this.groups.set(groupId, new Set(nodeIds))
  }

  replaceGroup(groupId: string, nodes: ConversationNode[]): void {
    const previousIds = this.groups.get(groupId) ?? new Set<string>()
    const nextIds = new Set(nodes.map((node) => node.id))
    for (const node of nodes) this.upsert(node)
    for (const id of previousIds) {
      if (!nextIds.has(id)) this.remove(id)
    }
    this.groups.set(groupId, nextIds)
  }

  update(id: string, update: (node: ConversationNode) => ConversationNode): boolean {
    const index = this.indexes.get(id)
    if (index === undefined) return false
    this.upsert(update(this.nodes[index]))
    return true
  }

  drainChanges(): ConversationProjectionChanges {
    const changes: ConversationProjectionChanges = {
      nodeUpserts: [...this.dirtyUpserts.values()],
      removedNodeIds: [...this.dirtyRemoved],
      ...(this.orderDirty ? { nodeOrder: this.nodes.map((node) => node.id) } : {})
    }
    this.dirtyUpserts.clear()
    this.dirtyRemoved.clear()
    this.orderDirty = false
    return changes
  }

  private upsert(node: ConversationNode): void {
    const index = this.indexes.get(node.id)
    if (index === undefined) {
      this.indexes.set(node.id, this.nodes.length)
      this.nodes.push(node)
      this.dirtyRemoved.delete(node.id)
      this.dirtyUpserts.set(node.id, node)
      this.orderDirty = true
      return
    }
    if (this.equals(this.nodes[index], node)) return
    this.nodes[index] = node
    this.dirtyUpserts.set(node.id, node)
  }

  private remove(id: string): void {
    const index = this.indexes.get(id)
    if (index === undefined) return
    this.nodes.splice(index, 1)
    this.indexes.delete(id)
    this.rebuildIndexes(index)
    this.dirtyUpserts.delete(id)
    this.dirtyRemoved.add(id)
    this.orderDirty = true
  }

  private rebuildIndexes(start: number): void {
    if (start === 0) this.indexes.clear()
    for (let index = start; index < this.nodes.length; index += 1) {
      this.indexes.set(this.nodes[index].id, index)
    }
  }
}
