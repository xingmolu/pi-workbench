export type AgentSessionIdentity = {
  sessionId: string | null
  generation: number
}

type IdentityListener = (
  identity: AgentSessionIdentity | null,
  previous: AgentSessionIdentity | null
) => void

let current: AgentSessionIdentity | null = null
const listeners = new Set<IdentityListener>()

function same(
  left: AgentSessionIdentity | null,
  right: AgentSessionIdentity | null
): boolean {
  return (
    left?.sessionId === right?.sessionId &&
    left?.generation === right?.generation
  )
}

export function setAgentSessionIdentity(identity: AgentSessionIdentity): void {
  const next = { ...identity }
  if (same(current, next)) return
  const previous = current
  current = next
  for (const listener of listeners) listener({ ...next }, previous && { ...previous })
}

export function clearAgentSessionIdentity(): void {
  if (!current) return
  const previous = current
  current = null
  for (const listener of listeners) listener(null, { ...previous })
}

export function readAgentSessionIdentity(): AgentSessionIdentity {
  return current ? { ...current } : { sessionId: null, generation: 0 }
}

export function subscribeAgentSessionIdentity(listener: IdentityListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
