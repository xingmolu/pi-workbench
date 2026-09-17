import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'

/** Stable identity used to fence stale commands and responses across session transitions. */
export type AgentRuntimeIdentity = {
  sessionId: string | null
  generation: number
}

/**
 * One resident Agent runtime bound to a desktop session worker.
 *
 * Desktop orchestration depends on this contract rather than on Electron
 * utilityProcess or the Pi SDK directly. A runtime may be local today and
 * remote or backed by another Agent implementation later.
 */
export interface AgentRuntimeSession {
  request(command: HostCommand, expectedIdentity?: AgentRuntimeIdentity): Promise<HostResult>
  /** Resolves only after this runtime cannot execute further work. */
  dispose(): Promise<void>
}

export type AgentRuntimeSessionOptions = {
  workerId: string
  cwd: string
  onEvent(event: HostEvent): void
  onExit(error?: Error): void
}

/**
 * Factory boundary between Desktop session orchestration and a concrete Agent
 * runtime implementation.
 */
export interface AgentRuntime {
  createSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeSession>
}

export type PrepareAgentRuntimeSession = (
  session: AgentRuntimeSession,
  snapshot: AgentSnapshot
) => Promise<AgentSnapshot | void>
