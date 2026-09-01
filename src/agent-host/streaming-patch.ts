import type { AgentSnapshot, AgentStatePatch, ConversationNode } from '../shared/contracts'
import { createStatePatch, type StatePatchNodeChanges } from '../shared/state-patch'

export type StreamingPatchResult =
  | { kind: 'patch'; snapshot: AgentSnapshot; patch: AgentStatePatch }
  | { kind: 'snapshot'; snapshot: AgentSnapshot }

export function buildStreamingPatch(input: {
  previous: AgentSnapshot | null
  sessionId: string | null
  generation: number
  nodes: ConversationNode[]
  changes: StatePatchNodeChanges
  buildDurableSnapshot: () => AgentSnapshot
}): StreamingPatchResult {
  const { previous } = input
  if (
    !previous ||
    previous.sessionId !== input.sessionId ||
    previous.generation !== input.generation
  ) {
    return { kind: 'snapshot', snapshot: input.buildDurableSnapshot() }
  }

  const snapshot: AgentSnapshot = {
    ...previous,
    revision: previous.revision + 1,
    nodes: input.nodes
  }
  return {
    kind: 'patch',
    snapshot,
    patch: createStatePatch(previous, snapshot, input.changes)
  }
}
