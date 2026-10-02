import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'
import {
  agentRuntimeManifestSchema,
  runtimeIdSchema,
  runtimeSupportsCommand,
  type AgentRuntimeManifest,
  type AgentRuntimeProviderId
} from '../shared/agent-runtime'
import { hostResultMatchesCommand } from '../shared/command-result'
import { hostMessageSchema, hostResultSchema } from '../shared/schemas'
import { HostRejectedError } from './host-response-broker'
import {
  prepareRuntimeStorage,
  runtimeStoragePaths,
  type RuntimeStoragePaths
} from './runtime-storage'
import { isAbsolute, relative } from 'node:path'
import { t } from '../shared/i18n'
export type { AgentRuntimeProviderId } from '../shared/agent-runtime'

export type AgentRuntimeProviderDescriptor = {
  id: AgentRuntimeProviderId
  label: string
  /** Runtime can expose host-owned capabilities such as browser/computer-use through an adapter. */
  hostCapabilities: boolean
  /** Runtime can keep one durable session per desktop worker. */
  residentSessions: boolean
  /** How plugin agent tools reach this runtime: registered natively, or through the host's
   * MCP bridge (see `src/agent-host/plugin-tool-mcp-bridge.ts`). Both pass the ToolGate. */
  toolDelivery?: 'native' | 'mcp'
  /** How plugin skills reach this runtime. */
  skills?: 'native' | 'prompt' | 'none'
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
  role?: 'configuration' | 'session'
  /** Immutable for the life of this worker; model provider is a separate identity. */
  runtimeId?: AgentRuntimeProviderId
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
  /** Resolve and validate selection before pool admission can evict another resident. */
  resolveProviderId?(id?: AgentRuntimeProviderId): AgentRuntimeProviderId
  createSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeSession>
}

export type RuntimePluginSessionOptions = AgentRuntimeSessionOptions & {
  runtimeId: AgentRuntimeProviderId
  storage: RuntimeStoragePaths
}

/** Trusted executable adapter. Third-party code loading/installation is a separate concern. */
export interface AgentRuntimePlugin {
  readonly manifest: AgentRuntimeManifest
  createSession(options: RuntimePluginSessionOptions): Promise<AgentRuntimeSession>
}

/**
 * Registry for interchangeable Agent backends. Main/session orchestration depends only on
 * AgentRuntime; Pi, Claude Code and Codex adapters translate their native protocols into the
 * same HostCommand/HostEvent and host-capability contracts.
 */
export class AgentRuntimeProviderRegistry implements AgentRuntime {
  private readonly providers = new Map<
    AgentRuntimeProviderId,
    {
      runtime: AgentRuntime
      manifest?: AgentRuntimeManifest
      plugin?: AgentRuntimePlugin
    }
  >()

  constructor(private readonly options: { dataRoot?: string; defaultProviderId?: string } = {}) {}

  registerPlugin(plugin: AgentRuntimePlugin): void {
    const manifest = agentRuntimeManifestSchema.parse(plugin.manifest)
    if (this.providers.has(manifest.id))
      throw new Error(`Agent runtime provider already registered: ${manifest.id}`)
    if (this.providers.size >= 64) throw new Error('Agent runtime provider limit exceeded')
    this.providers.set(manifest.id, {
      plugin,
      manifest: structuredClone(manifest),
      runtime: {
        provider: {
          id: manifest.id,
          label: manifest.label,
          hostCapabilities:
            manifest.features.includes('host-browser') ||
            manifest.features.includes('host-computer-use'),
          residentSessions: true,
          ...(manifest.toolDelivery === 'none' ? {} : { toolDelivery: manifest.toolDelivery }),
          skills: manifest.skills
        },
        createSession: (options) => this.createSession({ ...options, runtimeId: manifest.id })
      }
    })
  }

  register(runtime: AgentRuntime): void {
    const descriptor = runtime.provider
    if (!descriptor) throw new Error('Agent runtime provider descriptor is required')
    if (this.providers.has(descriptor.id)) {
      throw new Error(`Agent runtime provider already registered: ${descriptor.id}`)
    }
    runtimeIdSchema.parse(descriptor.id)
    this.providers.set(descriptor.id, { runtime })
  }

  resolveProviderId(id?: AgentRuntimeProviderId): AgentRuntimeProviderId {
    const selected = id ?? this.options.defaultProviderId ?? this.providers.keys().next().value
    if (!selected) throw new Error('No Agent runtime provider is registered')
    this.get(selected)
    return selected
  }

  get(id: AgentRuntimeProviderId): AgentRuntime {
    const entry = this.providers.get(id)
    if (!entry) throw new Error(`Agent runtime provider is not registered: ${id}`)
    return entry.runtime
  }

  list(): AgentRuntimeProviderDescriptor[] {
    return [...this.providers.values()]
      .map(({ runtime }) => runtime.provider!)
      .map((descriptor) => ({ ...descriptor }))
  }

  manifests(): AgentRuntimeManifest[] {
    return [...this.providers.values()].flatMap((entry) =>
      entry.manifest ? [structuredClone(entry.manifest)] : []
    )
  }

  async createSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeSession> {
    const id = this.resolveProviderId(options.runtimeId)
    const entry = this.providers.get(id)!
    if (!entry.plugin || !entry.manifest)
      return entry.runtime.createSession({ ...options, runtimeId: id })
    if (!this.options.dataRoot) throw new Error('Runtime plugin data root is required')
    const storage = runtimeStoragePaths(this.options.dataRoot, id)
    await prepareRuntimeStorage(storage)
    const manifest = entry.manifest
    let disposed = false
    let nativeSession: AgentRuntimeSession | undefined
    let disposal: Promise<void> | undefined
    let protocolFailure: Error | undefined
    const ownsSessionPath = (path: string): boolean => {
      const child = relative(storage.sessions, path)
      return isAbsolute(path) && !!child && !child.startsWith('..') && !isAbsolute(child)
    }
    const disposeNative = (): Promise<void> => {
      disposed = true
      if (!nativeSession) return Promise.resolve()
      return (disposal ??= nativeSession.dispose())
    }
    const project = (snapshot: AgentSnapshot): AgentSnapshot => {
      if (
        manifest.storage === 'desktop' &&
        snapshot.activeSessionPath &&
        !ownsSessionPath(snapshot.activeSessionPath)
      )
        throw new Error(`Runtime session must use desktop-owned storage: ${id}`)
      return {
        ...snapshot,
        engine: manifest.engine,
        runtime: structuredClone(manifest),
        sessions: snapshot.sessions.map((session) => ({ ...session, runtimeId: id }))
      }
    }
    const session = await entry.plugin.createSession({
      ...options,
      runtimeId: id,
      storage,
      onExit: (error) => {
        if (disposed) return
        disposed = true
        protocolFailure = error ?? new Error(`Agent runtime session exited: ${id}`)
        options.onExit(error)
        void disposeNative().catch(() => {})
      },
      onEvent: (event) => {
        if (disposed) return
        // In-process SDK adapters get the same validation as utility-process adapters.
        const parsed = hostMessageSchema.safeParse(event)
        try {
          if (!parsed.success || parsed.data.type !== 'event')
            throw new Error(`Invalid runtime event: ${id}`)
          const value = parsed.data
          if (value.event === 'snapshot') options.onEvent({ ...value, data: project(value.data) })
          else if (value.event === 'patch') {
            if (
              manifest.storage === 'desktop' &&
              value.data.meta.activeSessionPath &&
              !ownsSessionPath(value.data.meta.activeSessionPath)
            )
              throw new Error(`Runtime session must use desktop-owned storage: ${id}`)
            options.onEvent({
              ...value,
              data: {
                ...value.data,
                meta: {
                  ...value.data.meta,
                  engine: manifest.engine,
                  runtime: structuredClone(manifest),
                  ...(value.data.meta.sessions
                    ? {
                        sessions: value.data.meta.sessions.map((session) => ({
                          ...session,
                          runtimeId: id
                        }))
                      }
                    : {})
                }
              }
            })
          } else options.onEvent(value)
        } catch (error) {
          protocolFailure = error instanceof Error ? error : new Error(String(error))
          disposed = true
          options.onExit(protocolFailure)
          void disposeNative().catch(() => {})
        }
      }
    })
    nativeSession = session
    if (protocolFailure) {
      await disposeNative()
      throw protocolFailure
    }
    return {
      ...(session.getDiagnostics ? { getDiagnostics: () => session.getDiagnostics!() } : {}),
      async request(command, expectedIdentity) {
        if (disposed) throw new HostRejectedError('Agent runtime session is disposed')
        if (!runtimeSupportsCommand(manifest, command))
          throw new HostRejectedError(
            t('{label} 不支持操作：{type}', { label: manifest.label, type: command.type })
          )
        if ('runtimeId' in command && command.runtimeId && command.runtimeId !== id)
          throw new HostRejectedError('Runtime selection requires opening a new desktop worker')
        const resumePath =
          command.type === 'session:open'
            ? command.path
            : command.type === 'project:navigate'
              ? command.sessionPath
              : undefined
        if (manifest.storage === 'desktop' && resumePath && !ownsSessionPath(resumePath))
          throw new HostRejectedError('Session belongs to another runtime storage directory')
        const nativeResult = await session.request(command, expectedIdentity)
        if (disposed)
          throw protocolFailure ?? new Error(`Agent runtime session ended during request: ${id}`)
        const result = hostResultSchema.parse(nativeResult)
        if (!hostResultMatchesCommand(command, result))
          throw new Error(`Runtime response type mismatch: ${command.type}`)
        if (
          result.kind === 'snapshot' ||
          result.kind === 'session-fork' ||
          result.kind === 'subagent-inspection'
        )
          return { ...result, snapshot: project(result.snapshot) }
        if (result.kind === 'project-catalog')
          return {
            ...result,
            catalog: {
              ...result.catalog,
              projects: result.catalog.projects.map((project) => ({
                ...project,
                sessions: project.sessions.map((session) => ({ ...session, runtimeId: id }))
              }))
            }
          }
        return result
      },
      async dispose() {
        await disposeNative()
      }
    }
  }
}

export type PrepareAgentRuntimeSession = (
  session: AgentRuntimeSession,
  snapshot: AgentSnapshot
) => Promise<AgentSnapshot | void>
