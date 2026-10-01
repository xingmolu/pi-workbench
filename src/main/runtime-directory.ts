import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'
import type { AgentRuntimeProviderRegistry, AgentRuntimeSession } from './agent-runtime'
import type { CatalogProject } from '../shared/project-catalog'
import { comparePinned } from '../shared/navigation-library'
import { applyStatePatch } from '../shared/state-patch'

/** Configuration hosts have no foreground chat. Each plugin owns its accounts and history. */
export class RuntimeDirectory {
  private readonly hosts = new Map<string, Promise<AgentRuntimeSession>>()
  private readonly snapshots = new Map<string, AgentSnapshot>()
  private readonly paths = new Map<string, string>()

  constructor(
    private readonly options: {
      registry: AgentRuntimeProviderRegistry
      cwd: string
      onEvent(runtimeId: string, event: HostEvent): void
      onExit(runtimeId: string, error?: Error): void
      onRequestFailure?(runtimeId: string, command: HostCommand, error: unknown): void
      onCapability(owner: string, message: unknown, reply: (message: unknown) => void): boolean
    }
  ) {}

  owner(runtimeId: string): string {
    return `configuration:${runtimeId}`
  }
  snapshot(runtimeId: string): AgentSnapshot | null {
    return this.snapshots.get(runtimeId) ?? null
  }
  runtimeForPath(path: string): string | undefined {
    return this.paths.get(path)
  }

  private host(runtimeId: string): Promise<AgentRuntimeSession> {
    this.options.registry.resolveProviderId(runtimeId)
    let host = this.hosts.get(runtimeId)
    if (!host) {
      host = this.options.registry
        .createSession({
          runtimeId,
          role: 'configuration',
          workerId: this.owner(runtimeId),
          cwd: this.options.cwd,
          onEvent: (event) => {
            if (event.event === 'snapshot') this.remember(runtimeId, event.data)
            if (event.event === 'patch') {
              const snapshot = this.snapshot(runtimeId)
              if (snapshot) {
                const applied = applyStatePatch(snapshot, event.data)
                if (applied.status === 'applied') this.remember(runtimeId, applied.snapshot)
              }
            }
            this.options.onEvent(runtimeId, event)
          },
          onExit: (error) => {
            this.hosts.delete(runtimeId)
            this.snapshots.delete(runtimeId)
            this.options.onExit(runtimeId, error)
          },
          onCapability: (message, reply) =>
            this.options.onCapability(this.owner(runtimeId), message, reply)
        })
        .catch((error) => {
          this.hosts.delete(runtimeId)
          throw error
        })
      this.hosts.set(runtimeId, host)
    }
    return host
  }

  private remember(runtimeId: string, snapshot: AgentSnapshot): void {
    this.snapshots.set(runtimeId, snapshot)
    for (const session of snapshot.sessions) this.paths.set(session.path, runtimeId)
  }

  async request(runtimeId: string, command: HostCommand): Promise<HostResult> {
    const host = this.host(runtimeId)
    const session = await host
    const result = await session.request(command).catch((error) => {
      // A terminated host has already settled its ownership through onExit.
      if (this.hosts.get(runtimeId) === host)
        this.options.onRequestFailure?.(runtimeId, command, error)
      throw error
    })
    if (result.kind === 'snapshot') this.remember(runtimeId, result.snapshot)
    if (result.kind === 'project-catalog')
      for (const project of result.catalog.projects)
        for (const session of project.sessions) this.paths.set(session.path, runtimeId)
    if (result.kind === 'session-search')
      return {
        ...result,
        result: {
          ...result.result,
          items: result.result.items.map((item) => {
            this.paths.set(item.sessionPath, runtimeId)
            return { ...item, runtimeId }
          })
        }
      }
    return result
  }

  /** Read every plugin's durable directory without activating a chat or changing selection. */
  async query(
    command: Extract<HostCommand, { type: 'project:catalog' | 'session:search' | 'project:search' }>
  ): Promise<HostResult> {
    const runtimes = this.options.registry
      .manifests()
      .filter((runtime) => runtime.features.includes('project-catalog'))
    // One engine that cannot start (not installed, crashed, unsupported platform) must not
    // hide every other engine's projects and sessions. Only fail when none answered.
    const settled = await Promise.allSettled(
      runtimes.map((runtime) => this.request(runtime.id, command))
    )
    const results = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : []
    )
    if (!results.length && settled[0]?.status === 'rejected') throw settled[0].reason
    if (command.type === 'project:catalog') {
      const projects = new Map<string, CatalogProject>()
      let truncated = false,
        skippedDirectories = 0
      for (const result of results) {
        if (result.kind !== 'project-catalog')
          throw new Error('Runtime returned an invalid project catalog')
        truncated ||= result.catalog.truncated
        skippedDirectories += result.catalog.skippedDirectories ?? 0
        for (const project of result.catalog.projects) {
          const previous = projects.get(project.path)
          if (!previous) projects.set(project.path, { ...project })
          else
            projects.set(project.path, {
              ...previous,
              sessions: [...previous.sessions, ...project.sessions].sort(
                (a, b) =>
                  comparePinned(
                    command.navigation?.sessions[a.path],
                    command.navigation?.sessions[b.path]
                  ) ||
                  b.modified.localeCompare(a.modified) ||
                  a.path.localeCompare(b.path)
              ),
              totalSessions: previous.totalSessions + project.totalSessions,
              nextOffset:
                previous.nextOffset === null
                  ? project.nextOffset
                  : project.nextOffset === null
                    ? previous.nextOffset
                    : Math.min(previous.nextOffset, project.nextOffset)
            })
        }
      }
      const rows = [...projects.values()].sort((a, b) =>
        comparePinned(command.navigation?.projects[a.path], command.navigation?.projects[b.path])
      )
      return {
        kind: 'project-catalog',
        catalog: {
          projects: rows.slice(0, 100),
          totalProjects: Math.max(
            rows.length,
            ...results.map((result) =>
              result.kind === 'project-catalog' ? result.catalog.totalProjects : 0
            )
          ),
          truncated: truncated || rows.length > 100,
          skippedDirectories
        }
      }
    }
    if (command.type === 'session:search') {
      const values = results.map((result) => {
        if (result.kind !== 'session-search')
          throw new Error('Runtime returned an invalid session search')
        return result.result
      })
      const items = values
        .flatMap((value) => value.items)
        .sort(
          (a, b) =>
            comparePinned(
              command.navigation?.sessions[a.sessionPath],
              command.navigation?.sessions[b.sessionPath]
            ) ||
            b.modified.localeCompare(a.modified) ||
            a.sessionPath.localeCompare(b.sessionPath)
        )
        .slice(0, command.limit)
      const total = values.reduce((sum, value) => sum + value.total, 0)
      return {
        kind: 'session-search',
        result: {
          items,
          total,
          truncated: total > items.length,
          skippedDirectories: values.reduce((sum, value) => sum + value.skippedDirectories, 0),
          skippedEntries: values.reduce((sum, value) => sum + value.skippedEntries, 0)
        }
      }
    }
    const values = results.map((result) => {
      if (result.kind !== 'project-search')
        throw new Error('Runtime returned an invalid project search')
      return result.result
    })
    const projects = new Map(values.flatMap((value) => value.items).map((item) => [item.cwd, item]))
    return {
      kind: 'project-search',
      result: {
        items: [...projects.values()]
          .sort((a, b) =>
            comparePinned(command.navigation?.projects[a.cwd], command.navigation?.projects[b.cwd])
          )
          .slice(0, command.limit),
        total: Math.max(projects.size, ...values.map((value) => value.total)),
        ...(values.some((value) => value.truncated) ? { totalIsLowerBound: true } : {}),
        truncated: projects.size > command.limit || values.some((value) => value.truncated),
        skippedDirectories: values.reduce((sum, value) => sum + value.skippedDirectories, 0),
        skippedEntries: values.reduce((sum, value) => sum + value.skippedEntries, 0)
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.hosts.values()].map(async (host) => (await host).dispose()))
    this.hosts.clear()
    this.snapshots.clear()
  }
}
