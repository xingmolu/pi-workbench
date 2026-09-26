import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'

export type AgentRuntimeProviderId = 'pi' | 'claude-code' | 'codex' | (string & {})

export type AgentRuntimeProviderDescriptor = {
  id: AgentRuntimeProviderId
  label: string
  /** Runtime can expose host-owned capabilities such as browser/computer-use through an adapter. */
  hostCapabilities: boolean
  /** Runtime can keep one durable session per desktop worker. */
  residentSessions: boolean
}

/** Stable identity used to fence stale commands and responses across session transitions. */
export type AgentRuntimeIdentity = {
  sessionId: string | null
  generation: number
}

export type AgentRuntimeDiagnostics = Readonly<{
  pid: number | null
  pendingRequests: number
  disposing: boolean
  exited: boolean
}>

/**
 * One resident Agent runtime bound to a desktop session worker.
 *
 * Desktop orchestration depends on this contract rather than on Electron
 * utilityProcess or the Pi SDK directly. A runtime may be local today and
 * remote or backed by another Agent implementation later.
 */
export interface AgentRuntimeSession {
  /** Optional, read-only local process projection; contains no session content. */
  getDiagnostics?(): AgentRuntimeDiagnostics
  request(command: HostCommand, expectedIdentity?: AgentRuntimeIdentity): Promise<HostResult>
  /** Resolves only after this runtime cannot execute further work. */
  dispose(): Promise<void>
}

export type AgentRuntimeSessionOptions = {
  workerId: string
  cwd: string
  onEvent(event: HostEvent): void
  onExit(error?: Error): void
  /**
   * Runtime-private capability channel consumed before ordinary Host events.
   * Desktop services use it for worker-scoped protocols such as SessionTask;
   * concrete runtimes may ignore it when they do not expose raw messages.
   */
  onCapability?(message: unknown, reply: (message: unknown) => void): boolean
}

/**
 * Factory boundary between Desktop session orchestration and a concrete Agent
 * runtime implementation.
 */
export interface AgentRuntime {
  /**
   * Runtime identity is deliberately independent from model provider identity.
   * Example: Claude models may run through Pi today and Claude Code later.
   */
  readonly provider?: AgentRuntimeProviderDescriptor
  createSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeSession>
}

/**
 * Registry for interchangeable Agent backends. Main/session orchestration depends only on
 * AgentRuntime; Pi, Claude Code and Codex adapters translate their native protocols into the
 * same HostCommand/HostEvent and host-capability contracts.
 */
export class AgentRuntimeProviderRegistry {
  private readonly providers = new Map<AgentRuntimeProviderId, AgentRuntime>()

  register(runtime: AgentRuntime): void {
    const descriptor = runtime.provider
    if (!descriptor) throw new Error('Agent runtime provider descriptor is required')
    if (this.providers.has(descriptor.id)) {
      throw new Error(`Agent runtime provider already registered: ${descriptor.id}`)
    }
    this.providers.set(descriptor.id, runtime)
  }

  get(id: AgentRuntimeProviderId): AgentRuntime {
    const runtime = this.providers.get(id)
    if (!runtime) throw new Error(`Agent runtime provider is not registered: ${id}`)
    return runtime
  }

  list(): AgentRuntimeProviderDescriptor[] {
    return [...this.providers.values()]
      .map((runtime) => runtime.provider!)
      .map((descriptor) => ({ ...descriptor }))
  }
}

export type PrepareAgentRuntimeSession = (
  session: AgentRuntimeSession,
  snapshot: AgentSnapshot
) => Promise<AgentSnapshot | void>
