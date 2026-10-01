import { createHash, randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  query,
  listSessions,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  forkSession,
  renameSession,
  type Query,
  type SDKUserMessage,
  type ModelInfo,
  type Options,
  type McpServerConfig
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'
import { createEmptyAgentSnapshot } from '../shared/initial-agent-snapshot'
import { diffState } from '../shared/state-patch'
import { CLAUDE_RUNTIME_MANIFEST } from '../shared/claude-runtime'
import { SerialExecutor } from '../agent-host/serial-executor'
import { ApprovalRegistry } from '../agent-host/approval-registry'
import { ProjectMutationClient } from '../agent-host/project-mutation-client'
import { mutationResponseSchema } from '../shared/runtime-capabilities'
import { mcpServerSchema, type McpServer, type McpSnapshot } from '../shared/mcp'
import { ClaudeSessionStore, type ClaudeStorage, type SessionReference } from './storage'
import { readClaudeCatalog } from './catalog'
import type { ProjectCatalogCommand } from '../shared/project-catalog'
import { ClaudeProjection, intent } from './projection'
import { InputStream } from './input'
import { nativeSkillPlugins } from './skills'
import { ClaudeBridge } from './bridge'
import { officialAuthUrl } from './auth'
import {
  DEFAULT_CONNECTION,
  activeConnection,
  connectionEnvironment,
  connections,
  newConnectionId,
  prepareAccountHome,
  removeAccountHome
} from './connections'
import {
  bundledClaudeExecutable,
  claudeEnvironment,
  readConfig,
  saveConfig,
  type ClaudeConfig
} from './config'

type NativeQuery = Query
const SDK_MODE = { ask: 'default', auto: 'default', open: 'bypassPermissions' } as const
const ORCHESTRATOR_TOOLS = new Set([
  'Agent',
  'Task',
  'TaskStop',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode'
])
const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TaskOutput',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool'
])
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function mcpConfig(server: McpServer): McpServerConfig {
  if (server.url)
    return { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
  return {
    type: 'stdio',
    command: server.command!,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {})
  }
}
export type ClaudeHostOptions = {
  storage: ClaudeStorage
  post(message: unknown): void
  role?: 'configuration' | 'session'
  /** Injectable only for isolated tests; production always uses the official bundled SDK. */
  sdkQuery?: typeof query
  executable?: string
}

export class ClaudeHost {
  private readonly commands = new SerialExecutor()
  private snapshot: AgentSnapshot
  private published: AgentSnapshot
  private readonly projection = new ClaudeProjection()
  readonly store: ClaudeSessionStore
  readonly approvals: ApprovalRegistry
  readonly mutations: ProjectMutationClient
  readonly bridge: ClaudeBridge
  private native: NativeQuery | undefined
  private input: InputStream<SDKUserMessage> | undefined
  private stream: Promise<void> | undefined
  private initializing: Promise<void> | undefined
  private config: ClaudeConfig = {}
  private models: ModelInfo[] = []
  private reference: SessionReference | undefined
  private abort: AbortController | undefined
  private queryEpoch = 0
  private leases = new Set<string>()
  private mainRunning = false
  private disposed = false
  private transitioning = false
  private authProcess: ChildProcess | undefined
  private userMcp: Record<string, McpServer> = {}
  private mcpRevision = '0'
  constructor(private readonly options: ClaudeHostOptions) {
    this.store = new ClaudeSessionStore(options.storage)
    this.snapshot = createEmptyAgentSnapshot(CLAUDE_RUNTIME_MANIFEST.engine, options.storage.config)
    this.snapshot.runtime = CLAUDE_RUNTIME_MANIFEST
    this.published = structuredClone(this.snapshot)
    // The SDK's history functions resolve the config directory in this utility process.
    process.env.CLAUDE_CONFIG_DIR = options.storage.config
    this.mutations = new ProjectMutationClient(options.post)
    this.bridge = new ClaudeBridge(options.post, () => ({
      sessionId: this.snapshot.sessionId,
      generation: this.snapshot.generation,
      cwd: this.snapshot.project?.path ?? options.storage.cache
    }))
    this.approvals = new ApprovalRegistry((change) => {
      this.projection.tool(change.request.toolCallId, {
        status:
          change.status === 'pending'
            ? 'awaiting-approval'
            : change.status === 'allowed'
              ? 'running'
              : 'blocked'
      })
      this.snapshot.approvals = this.approvals.requests(this.snapshot.generation)
      if (this.snapshot.busy)
        this.snapshot.status = this.snapshot.approvals.length ? 'awaiting-approval' : 'running'
      this.publish()
    })
  }
  getState(): AgentSnapshot {
    return structuredClone(this.snapshot)
  }
  accept(message: unknown): boolean {
    const mutation = mutationResponseSchema.safeParse(message)
    if (mutation.success) {
      this.mutations.accept(mutation.data)
      return true
    }
    return this.bridge.accept(message)
  }
  private isBusy(): boolean {
    return (
      this.mainRunning ||
      [...this.projection.tasks.values()].some((task) =>
        ['running', 'queued', 'awaiting-approval'].includes(task.state)
      )
    )
  }
  private publish(full = false): void {
    this.snapshot.busy = this.isBusy()
    if (this.snapshot.busy)
      this.snapshot.status = this.snapshot.approvals.length ? 'awaiting-approval' : 'running'
    else if (this.snapshot.status === 'running' || this.snapshot.status === 'awaiting-approval')
      this.snapshot.status = 'idle'
    this.snapshot.nodes = structuredClone(this.projection.nodes)
    const forkPoint = [...this.snapshot.nodes]
      .reverse()
      .find((node) => (node.type === 'assistant' || node.type === 'user') && node.canonicalEntryId)
    const entryId =
      forkPoint && (forkPoint.type === 'assistant' || forkPoint.type === 'user')
        ? (forkPoint.canonicalEntryId ?? null)
        : null
    this.snapshot.fork = {
      entryId,
      reason: this.isBusy()
        ? 'Stop the current Claude turn first'
        : !entryId
          ? 'No saved conversation entry to fork'
          : null
    }
    this.snapshot.revision++
    this.snapshot.composeBlockReason = !this.snapshot.project
      ? 'project-required'
      : !this.snapshot.accounts.some((account) => account.connected)
        ? 'login-required'
        : !this.snapshot.activeModel
          ? 'model-required'
          : this.snapshot.modelAvailability === 'unavailable'
            ? 'model-unavailable'
            : null
    const next = this.getState()
    const event: HostEvent =
      full ||
      next.sessionId !== this.published.sessionId ||
      next.generation !== this.published.generation
        ? { type: 'event', event: 'snapshot', data: next }
        : { type: 'event', event: 'patch', data: diffState(this.published, next) }
    this.published = next
    this.options.post(event)
  }
  private ack(): HostResult {
    return {
      kind: 'ack',
      sessionId: this.snapshot.sessionId,
      generation: this.snapshot.generation,
      revision: this.snapshot.revision
    }
  }
  private result(): HostResult {
    return { kind: 'snapshot', snapshot: this.getState() }
  }
  private assertIdle(): void {
    if (this.isBusy() || this.transitioning || this.authProcess)
      throw new Error('Stop the current Claude turn before changing the session')
  }
  private assertIdentity(command: { sessionId: string | null; generation: number }): void {
    if (
      command.sessionId !== this.snapshot.sessionId ||
      command.generation !== this.snapshot.generation
    )
      throw new Error('Claude session identity has changed')
  }
  private async refreshCatalog(): Promise<void> {
    if (!this.snapshot.project) return
    const native = await listSessions({ dir: this.snapshot.project.path })
    this.snapshot.sessions = await this.store.summaries(
      native,
      this.snapshot.project.path,
      this.snapshot.sessionId
    )
    this.snapshot.sessions = this.snapshot.sessions.map((session) =>
      session.active
        ? {
            ...session,
            status: this.snapshot.status
          }
        : session
    )
  }
  private async stopQuery(): Promise<void> {
    this.queryEpoch++
    this.mainRunning = false
    this.projection.stopTasks()
    this.abort?.abort()
    this.input?.close()
    this.native?.close()
    await this.stream?.catch(() => {})
    this.native = undefined
    this.input = undefined
    this.initializing = undefined
    this.stream = undefined
    this.approvals.clear(this.snapshot.generation, 'session-switch')
    this.releaseLeases()
  }
  private releaseLeases(): void {
    for (const id of this.leases) this.mutations.release(id)
    this.leases.clear()
  }
  private async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Claude runtime is disposed')
    if (this.initializing && this.snapshot.ready) return this.initializing
    if (this.initializing && this.native && !this.snapshot.error) return this.initializing
    if (this.native) await this.stopQuery()
    this.initializing = this.startQuery()
    try {
      await this.initializing
    } catch (error) {
      await this.stopQuery()
      throw error
    }
  }
  private async startQuery(): Promise<void> {
    const epoch = ++this.queryEpoch
    this.config = await readConfig(this.options.storage)
    await mkdir(this.options.storage.cache, { recursive: true })
    const contributions = await this.bridge.contributions()
    if (this.disposed || epoch !== this.queryEpoch)
      throw new Error('Claude initialization was cancelled')
    const plugins = await nativeSkillPlugins(this.options.storage.cache, contributions.skillPaths)
    if (this.disposed || epoch !== this.queryEpoch)
      throw new Error('Claude initialization was cancelled')
    const input = new InputStream<SDKUserMessage>()
    this.input = input
    const enabledMcp: Record<string, McpServerConfig> = {}
    for (const [id, server] of Object.entries({ ...contributions.mcpServers, ...this.userMcp }))
      if (!server.disabled) enabledMcp[id] = mcpConfig(server)
    const queryOptions: Options = {
      cwd: this.snapshot.project?.path ?? this.options.storage.cache,
      env: connectionEnvironment(this.options.storage, this.config, this.connection()),
      pathToClaudeCodeExecutable: this.options.executable ?? bundledClaudeExecutable(),
      settingSources: ['user'],
      persistSession: !!this.snapshot.project && this.options.role !== 'configuration',
      includePartialMessages: true,
      permissionMode: SDK_MODE[this.snapshot.permissionMode],
      allowDangerouslySkipPermissions: true,
      ...(this.reference && this.projection.nodes.length
        ? { resume: this.reference.nativeSessionId }
        : this.reference
          ? { sessionId: this.reference.nativeSessionId }
          : {}),
      ...((this.snapshot.activeModel ?? this.config.model)
        ? { model: this.snapshot.activeModel ?? this.config.model }
        : {}),
      ...(this.config.effort ? { effort: this.config.effort } : {}),
      plugins,
      mcpServers: {
        ...enabledMcp,
        desktop: this.bridge.server(contributions, () => this.abort?.signal)
      },
      canUseTool: async (name, input, context) => {
        const allow =
          this.snapshot.permissionMode === 'open' ||
          (this.snapshot.permissionMode === 'auto' &&
            (READ_TOOLS.has(name) || ['Write', 'Edit', 'NotebookEdit'].includes(name))) ||
          (await this.approvals.request(
            {
              id: `claude:${context.toolUseID}`,
              toolCallId: context.toolUseID,
              generation: this.snapshot.generation,
              toolName: name,
              intent: intent(name),
              title: context.title ?? name,
              detail: (context.description ?? JSON.stringify(input)).slice(0, 8000)
            },
            context.signal
          ))
        if (!allow) {
          this.mutations.release(context.toolUseID)
          this.leases.delete(context.toolUseID)
        }
        return allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Desktop permission denied or cancelled' }
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (event, _id, context) => {
                if (event.hook_event_name !== 'PreToolUse') return {}
                if (
                  !READ_TOOLS.has(event.tool_name) &&
                  !ORCHESTRATOR_TOOLS.has(event.tool_name) &&
                  this.snapshot.sessionId
                ) {
                  this.leases.add(event.tool_use_id)
                  this.projection.tool(event.tool_use_id, { status: 'waiting-resource' })
                  this.publish()
                  try {
                    await this.mutations.acquire(
                      event.tool_use_id,
                      { sessionId: this.snapshot.sessionId, generation: this.snapshot.generation },
                      context.signal
                    )
                  } catch {
                    this.leases.delete(event.tool_use_id)
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'Project mutation cancelled'
                      }
                    }
                  }
                }
                this.projection.tool(event.tool_use_id, { status: 'running' })
                this.publish()
                return this.snapshot.permissionMode === 'ask'
                  ? {
                      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' }
                    }
                  : {}
              }
            ]
          }
        ],
        PostToolUse: [
          {
            hooks: [
              async (event) => {
                if (event.hook_event_name === 'PostToolUse') {
                  this.mutations.release(event.tool_use_id)
                  this.leases.delete(event.tool_use_id)
                }
                return {}
              }
            ]
          }
        ],
        PostToolUseFailure: [
          {
            hooks: [
              async (event) => {
                if (event.hook_event_name === 'PostToolUseFailure') {
                  this.mutations.release(event.tool_use_id)
                  this.leases.delete(event.tool_use_id)
                }
                return {}
              }
            ]
          }
        ]
      }
    }
    const native = (this.options.sdkQuery ?? query)({ prompt: input, options: queryOptions })
    this.native = native
    this.stream = (async () => {
      try {
        for await (const message of native) {
          if (epoch !== this.queryEpoch || this.disposed) break
          this.projection.accept(message)
          if (
            message.type === 'stream_event' &&
            message.parent_tool_use_id === null &&
            message.event.type === 'message_start'
          )
            this.mainRunning = true
          if (message.type === 'system' && message.subtype === 'session_state_changed')
            this.mainRunning = message.state !== 'idle'
          if (message.type === 'system' && message.subtype === 'init') {
            if (this.reference && message.session_id !== this.reference.nativeSessionId)
              throw new Error('SDK returned an unexpected session ID')
            // The wire model can differ from catalog aliases; public selection stays resolvable.
            if (!this.snapshot.activeModel)
              this.snapshot.activeModel =
                this.models.find(
                  (model) => model.value === message.model || model.resolvedModel === message.model
                )?.value ?? null
          }
          if (message.type === 'result') {
            this.mainRunning = false
            this.snapshot.busy = this.isBusy()
            this.snapshot.status = this.abort?.signal.aborted
              ? 'stopped'
              : message.is_error
                ? 'error'
                : 'idle'
            this.snapshot.error = message.is_error
              ? 'errors' in message
                ? message.errors.join('\n')
                : message.result
              : undefined
            this.projection.finish()
            for (const denial of message.permission_denials) {
              this.mutations.release(denial.tool_use_id)
              this.leases.delete(denial.tool_use_id)
            }
            // Native background children can still be awaiting their own permission callback.
            // Their signal, explicit cancellation or query termination owns that lifetime.
            const totals = Object.values(message.modelUsage)
            this.snapshot.metrics = {
              turns: this.snapshot.metrics.turns + 1,
              steps: message.num_turns,
              input: totals.reduce((sum, usage) => sum + usage.inputTokens, 0),
              output: totals.reduce((sum, usage) => sum + usage.outputTokens, 0),
              cacheRead: totals.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0),
              cacheWrite: totals.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0),
              llmDurationMs: message.duration_api_ms,
              ...(totals[0] ? { contextWindow: totals[0].contextWindow } : {})
            }
            if (this.snapshot.error)
              this.projection.upsert({
                id: `error:${message.uuid}`,
                type: 'error',
                message: this.snapshot.error
              })
            await this.refreshCatalog()
          }
          this.publish()
        }
        if (epoch === this.queryEpoch && !this.disposed) throw new Error('Claude SDK stream ended')
      } catch (error) {
        if (epoch !== this.queryEpoch || this.disposed) return
        native.close()
        this.mainRunning = false
        this.projection.stopTasks()
        this.snapshot.busy = false
        this.snapshot.status = 'error'
        this.snapshot.ready = false
        this.snapshot.error = errorText(error)
        this.projection.finish()
        this.releaseLeases()
        this.approvals.clear(this.snapshot.generation, 'abort')
        this.publish()
      }
    })()
    const [models, account] = await Promise.all([native.supportedModels(), native.accountInfo()])
    if (epoch !== this.queryEpoch) throw new Error('Claude initialization was cancelled')
    this.models = models
    const active = this.connection()
    const signedIn = !!(
      account.email ||
      (account.apiKeySource && account.apiKeySource !== 'none') ||
      (account.tokenSource && account.tokenSource !== 'none')
    )
    await this.rememberIdentity(active, account.email, account.subscriptionType)
    this.snapshot.accounts = connections(this.config).map((connection) => {
      if (connection.kind === 'api') {
        const endpoint = connection.baseUrl ? hostOf(connection.baseUrl) : 'api.anthropic.com'
        return {
          id: connection.id,
          name: connection.label ?? endpoint,
          authType: 'api_key' as const,
          connected: true,
          subscription: false,
          alias: false,
          endpoint
        }
      }
      const apiKey = connection.kind === 'default' && !!this.config.apiKey
      return {
        id: connection.id,
        name: connection.email ?? (apiKey ? 'Anthropic API' : 'Claude'),
        authType: apiKey ? ('api_key' as const) : ('oauth' as const),
        // Only the active connection is verified by the SDK; the others were when added.
        connected: connection.id === active ? signedIn : !!(connection.email || apiKey),
        subscription: !apiKey,
        alias: connection.kind === 'account',
        ...(apiKey
          ? { endpoint: this.config.baseUrl ? hostOf(this.config.baseUrl) : 'api.anthropic.com' }
          : { platform: 'claude' as const }),
        ...(connection.email && !apiKey ? { email: connection.email } : {}),
        ...(connection.plan && !apiKey ? { plan: connection.plan } : {})
      }
    })
    // Claude offers the same models through every connection; list them per connection so
    // the composer can switch account and model in one choice.
    // The active connection always lists its models, signed in or not, so discovery works
    // before login; other connections only once they can actually be used.
    this.snapshot.models = this.snapshot.accounts
      .filter((item) => item.connected || item.id === active)
      .flatMap((item) =>
        models.map((model) => ({
          provider: item.id,
          id: model.value,
          name: model.displayName,
          contextWindow: 0,
          reasoning: !!model.supportsEffort || !!model.supportsAdaptiveThinking,
          input: ['text', 'image'] as Array<'text' | 'image'>
        }))
      )
    this.snapshot.activeProvider = active
    this.snapshot.activeModel ??= this.config.model ?? models[0]?.value ?? null
    this.updateModelState()
    this.snapshot.ready = true
    this.snapshot.error = undefined
  }
  private updateModelState(): void {
    const model = this.models.find(
      (model) =>
        model.value === this.snapshot.activeModel ||
        model.resolvedModel === this.snapshot.activeModel
    )
    if (model) this.snapshot.activeModel = model.value
    this.snapshot.modelAvailability = !this.snapshot.activeModel
      ? 'unselected'
      : model
        ? 'available'
        : 'unavailable'
    this.snapshot.thinking = model?.supportsEffort
      ? { level: this.config.effort ?? 'high', available: model.supportedEffortLevels ?? [] }
      : null
  }
  private async transition(
    cwd: string,
    reference?: SessionReference,
    connection?: string
  ): Promise<HostResult> {
    this.assertIdle()
    this.transitioning = true
    try {
      const project = resolve(cwd)
      if (!(await stat(project)).isDirectory()) throw new Error('Project directory is unavailable')
      await this.stopQuery()
      this.projection.clear()
      this.snapshot.generation++
      this.snapshot.revision = 0
      this.reference = reference ?? {
        version: 1,
        runtimeId: 'claude',
        nativeSessionId: randomUUID(),
        cwd: project,
        created: new Date().toISOString(),
        // A new session starts on the chosen connection, else the current default, and
        // keeps it when the default changes later.
        connection: connection ?? activeConnection(await readConfig(this.options.storage))
      }
      if (this.reference.cwd !== project) throw new Error('Session belongs to a different project')
      this.snapshot.project = { path: project, name: basename(project) }
      this.snapshot.sessionId = this.reference.nativeSessionId
      this.snapshot.activeSessionPath = await this.store.save(this.reference)
      this.snapshot.status = 'idle'
      this.snapshot.busy = false
      this.snapshot.error = undefined
      this.snapshot.metrics = {
        turns: 0,
        steps: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      }
      if (reference) {
        this.projection.load(await getSessionMessages(reference.nativeSessionId, { dir: project }))
        for (const agentId of await listSubagents(reference.nativeSessionId, { dir: project })) {
          const savedTask = this.projection.tasks.get(agentId)
          // Native IDs are the inspection authority; transcript output links their display row.
          const spawningTool = this.projection.nodes.find(
            (node) =>
              node.type === 'tool' &&
              ['Agent', 'Task'].includes(node.name) &&
              (node.toolCallId === savedTask?.workerId || node.output?.includes(agentId))
          )
          const input =
            spawningTool?.type === 'tool'
              ? this.projection.agentInputs.get(spawningTool.toolCallId)
              : undefined
          const child = {
            ...savedTask,
            id: agentId,
            title: input?.title ?? savedTask?.title ?? 'Saved subagent',
            ...(input?.prompt ? { prompt: input.prompt } : {}),
            state: savedTask?.state ?? ('idle' as const),
            sessionId: reference.nativeSessionId,
            ...(spawningTool?.type === 'tool' ? { workerId: spawningTool.toolCallId } : {})
          }
          this.projection.tasks.set(agentId, child)
          if (spawningTool?.type === 'tool')
            this.projection.tool(spawningTool.toolCallId, {
              subagent: { operation: 'observe', children: [child] }
            })
          else
            this.projection.upsert({
              id: `saved-task:${agentId}`,
              type: 'tool',
              toolCallId: agentId,
              name: 'Agent',
              intent: 'generic',
              title: child.title,
              status: 'incomplete',
              subagent: { operation: 'observe', children: [child] }
            })
        }
      }
      await this.initialize()
      await this.refreshCatalog()
      this.publish(true)
      return this.result()
    } finally {
      this.transitioning = false
    }
  }
  handle(
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    const execute = () => this.execute(command, expectedIdentity)
    return [
      'permission:respond',
      'prompt:abort',
      'session-task:cancel',
      'runtime:shutdown'
    ].includes(command.type)
      ? execute()
      : this.commands.run(execute)
  }
  private async execute(
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    if (this.disposed && command.type !== 'runtime:shutdown')
      throw new Error('Claude runtime is disposed')
    if (expectedIdentity) this.assertIdentity(expectedIdentity)
    if ('sessionId' in command && 'generation' in command) this.assertIdentity(command)
    switch (command.type) {
      case 'bootstrap':
        await this.loadMcp()
        await this.initialize()
        this.publish(true)
        return this.result()
      case 'state:get':
        if (command.refreshSessions) {
          await this.refreshCatalog()
          this.publish()
        }
        return this.result()
      case 'runtime:refresh':
        this.assertIdle()
        await this.stopQuery()
        await this.loadMcp()
        await this.initialize()
        this.publish()
        return this.result()
      case 'runtime:shutdown': {
        this.disposed = true
        this.authProcess?.kill()
        this.bridge.close()
        const initializing = this.initializing
        await this.stopQuery()
        await initializing?.catch(() => {})
        this.snapshot.ready = false
        return this.result()
      }
      case 'project:open':
        return this.transition(command.cwd)
      case 'project:navigate':
        return this.transition(
          command.cwd,
          command.sessionPath ? await this.store.read(command.sessionPath) : undefined
        )
      case 'session:open': {
        const reference = await this.store.read(command.path)
        return this.transition(reference.cwd, reference)
      }
      case 'session:new':
        if (!this.snapshot.project) throw new Error('Open a project first')
        if ('modelId' in command) {
          this.validateModel(command.providerId, command.modelId)
          this.snapshot.activeModel = command.modelId
          return this.transition(this.snapshot.project.path, undefined, command.providerId)
        }
        return this.transition(this.snapshot.project.path)
      case 'session:rename': {
        this.assertIdle()
        if (!this.reference) throw new Error('No Claude session')
        if (
          (await listSessions({ dir: this.reference.cwd })).some(
            (session) => session.sessionId === this.reference!.nativeSessionId
          )
        )
          await renameSession(this.reference.nativeSessionId, command.name, {
            dir: this.reference.cwd
          })
        this.reference.title = command.name
        await this.store.save(this.reference)
        await this.refreshCatalog()
        this.publish()
        return this.ack()
      }
      case 'session:fork': {
        this.assertIdle()
        if (!this.reference) throw new Error('No Claude session')
        const nativeId = command.entryId.includes(':')
          ? command.entryId.split(':')[0]
          : command.entryId
        const messages = await getSessionMessages(this.reference.nativeSessionId, {
          dir: this.reference.cwd
        })
        if (!messages.some((message) => message.uuid === nativeId))
          throw new Error('Fork target is not a native transcript entry')
        const sourcePath = this.snapshot.activeSessionPath!
        const fork = await forkSession(this.reference.nativeSessionId, {
          dir: this.reference.cwd,
          upToMessageId: nativeId
        })
        const reference = {
          ...this.reference,
          nativeSessionId: fork.sessionId,
          created: new Date().toISOString(),
          parentSessionPath: sourcePath
        }
        delete reference.title
        await this.transition(reference.cwd, reference)
        return { kind: 'session-fork', cancelled: false, snapshot: this.getState() }
      }
      case 'prompt:send': {
        if (!this.snapshot.project || !this.snapshot.sessionId)
          throw new Error('Open a project first')
        this.assertIdle()
        await this.initialize()
        this.assertIdentity(command)
        this.assertIdle()
        if (this.snapshot.composeBlockReason)
          throw new Error(`Claude cannot compose: ${this.snapshot.composeBlockReason}`)
        const uuid = randomUUID()
        this.abort = new AbortController()
        this.mainRunning = true
        this.snapshot.busy = true
        this.snapshot.status = 'running'
        this.snapshot.error = undefined
        this.projection.upsert({
          id: uuid,
          type: 'user',
          text: command.text,
          canonicalEntryId: uuid,
          ...(command.images?.length ? { imageCount: command.images.length } : {})
        })
        const content: SDKUserMessage['message']['content'] = command.images?.length
          ? [
              { type: 'text', text: command.text },
              ...command.images.map((image) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: image.mimeType, data: image.data }
              }))
            ]
          : command.text
        this.input!.push({
          type: 'user',
          uuid,
          session_id: this.snapshot.sessionId,
          parent_tool_use_id: null,
          message: { role: 'user', content }
        })
        this.publish()
        return this.ack()
      }
      case 'prompt:abort':
        this.abort?.abort()
        this.approvals.clear(this.snapshot.generation, 'abort')
        this.mutations.cancelQueued()
        if (this.native && this.snapshot.busy) await this.native.interrupt()
        await this.stopQuery()
        this.snapshot.busy = false
        this.snapshot.status = 'stopped'
        this.projection.finish()
        this.releaseLeases()
        this.projection.upsert({
          id: randomUUID(),
          type: 'stopped',
          message: 'Claude turn stopped'
        })
        this.publish()
        return this.ack()
      case 'permission:set':
        this.snapshot.permissionMode = command.mode
        if (this.native) await this.native.setPermissionMode(SDK_MODE[command.mode])
        this.publish()
        return this.ack()
      case 'permission:respond':
        if (!this.approvals.resolve(command.approvalId, this.snapshot.generation, command.allow))
          throw new Error('Approval has expired')
        return this.ack()
      case 'model:set':
        this.assertIdle()
        this.validateModel(command.providerId, command.modelId)
        if (command.providerId !== this.connection()) {
          this.config.model = command.modelId
          this.snapshot.activeModel = command.modelId
          await this.useConnection(command.providerId)
        }
        await this.native?.setModel(command.modelId)
        this.snapshot.activeModel = command.modelId
        this.config.model = command.modelId
        await saveConfig(this.options.storage, this.config)
        this.updateModelState()
        this.publish()
        return this.ack()
      case 'thinking:set': {
        this.assertIdle()
        const available = this.snapshot.thinking?.available ?? []
        if (!available.includes(command.level))
          throw new Error('This Claude model does not support that effort level')
        this.config.effort = command.level as ClaudeConfig['effort']
        await this.native?.applyFlagSettings({ effortLevel: this.config.effort })
        await saveConfig(this.options.storage, this.config)
        this.updateModelState()
        this.publish()
        return this.ack()
      }
      case 'account:api-key:set':
        this.assertIdle()
        if (command.providerId === 'new') {
          const config = await readConfig(this.options.storage)
          const id = newConnectionId('api')
          config.apis = [
            ...(config.apis ?? []),
            {
              id,
              apiKey: command.apiKey,
              ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
              ...(command.label ? { label: command.label } : {})
            }
          ]
          config.active = id
          this.config = config
          await saveConfig(this.options.storage, config)
          await this.stopQuery()
          await this.initialize()
          this.publish()
          return this.ack()
        }
        if (command.providerId !== DEFAULT_CONNECTION)
          throw new Error('Claude runtime supports the Anthropic account')
        this.config = {
          ...(await readConfig(this.options.storage)),
          ...(command.apiKey ? { apiKey: command.apiKey } : {})
        }
        if (!command.apiKey) delete this.config.apiKey
        if (command.baseUrl) this.config.baseUrl = command.baseUrl
        else delete this.config.baseUrl
        await saveConfig(this.options.storage, this.config)
        await this.stopQuery()
        await this.initialize()
        this.publish()
        return this.ack()
      case 'account:login':
        this.assertIdle()
        await this.login(command.providerId, command.method)
        return this.ack()
      case 'account:add':
        if (command.platform !== 'claude') throw new Error('Claude Code 只能添加 Claude 订阅账号')
        await this.addAccount()
        return this.ack()
      case 'account:remove':
        await this.removeConnection(command.providerId)
        this.publish()
        return this.ack()
      case 'session-task:cancel':
        if (!this.projection.tasks.has(command.taskId)) throw new Error('Unknown Claude task')
        if (!this.native) throw new Error('Claude task runtime is no longer running')
        await this.native.stopTask(command.taskId)
        return this.ack()
      case 'subagent:inspect': {
        const task = this.projection.tasks.get(command.taskId)
        if (!task || !this.reference) throw new Error('Unknown Claude subagent')
        const live = this.projection.children.get(task.workerId ?? '')
        const child = new ClaudeProjection()
        let messages = await getSubagentMessages(this.reference.nativeSessionId, command.taskId, {
          dir: this.reference.cwd
        })
        // SDK task completion can precede its queued transcript flush by a few milliseconds.
        for (
          let attempt = 0;
          task.state === 'success' &&
          !messages.some((message) => message.type === 'assistant') &&
          attempt < 8;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          messages = await getSubagentMessages(this.reference.nativeSessionId, command.taskId, {
            dir: this.reference.cwd
          })
        }
        if (messages.length) child.load(messages)
        if (!messages.length && live) child.nodes = structuredClone(live.nodes)
        else if (live && task.state === 'running') {
          for (const node of live.nodes) {
            if (
              (node.type === 'assistant' || node.type === 'think') &&
              node.streaming &&
              !child.nodes.some((saved) => saved.presentationIdentity === node.presentationIdentity)
            )
              child.upsert(structuredClone(node))
          }
        }
        return {
          kind: 'subagent-inspection',
          snapshot: {
            ...this.getState(),
            sessionId: command.taskId,
            nodes: child.nodes,
            busy: task.state === 'running',
            status:
              task.state === 'running'
                ? 'running'
                : task.state === 'error'
                  ? 'error'
                  : task.state === 'stopped'
                    ? 'stopped'
                    : 'idle',
            approvals: [],
            sessions: []
          }
        }
      }
      case 'project:catalog':
        return this.catalog(command)
      case 'session:search':
      case 'project:search':
        return this.search(command)
      case 'browser:e2e':
        if (process.env.PI_DESKTOP_E2E !== '1')
          throw new Error('Browser test command is available only in E2E mode')
        await this.bridge.browser(command.operation)
        return this.ack()
      case 'mcp:list':
        return { kind: 'mcp', result: await this.mcpSnapshot() }
      case 'mcp:reload':
        this.assertIdle()
        await this.stopQuery()
        await this.loadMcp()
        await this.initialize()
        this.publish()
        return { kind: 'mcp', result: await this.mcpSnapshot() }
      case 'mcp:save':
        this.assertIdle()
        if (command.revision !== this.mcpRevision) throw new Error('MCP configuration changed')
        if (command.id === 'desktop')
          throw new Error('Desktop MCP bridge is managed by the runtime')
        if (command.create && this.userMcp[command.id]) throw new Error('MCP server already exists')
        if (!command.create && !this.userMcp[command.id]) throw new Error('Unknown MCP server')
        this.userMcp[command.id] = {
          ...mcpServerSchema.parse(command.server),
          disabled: !command.enabled
        }
        await this.saveMcp()
        await this.stopQuery()
        await this.initialize()
        this.publish()
        return {
          kind: 'mcp',
          result: { ...(await this.mcpSnapshot()), saved: true, applied: true }
        }
      case 'mcp:toggle':
        this.assertIdle()
        if (command.revision !== this.mcpRevision) throw new Error('MCP configuration changed')
        if (!this.userMcp[command.id]) throw new Error('Unknown MCP server')
        this.userMcp[command.id].disabled = !command.enabled
        await this.saveMcp()
        await this.stopQuery()
        await this.initialize()
        this.publish()
        return { kind: 'mcp', result: await this.mcpSnapshot() }
      case 'mcp:shutdown':
        this.assertIdle()
        await this.native?.setMcpServers({})
        return { kind: 'mcp', result: await this.mcpSnapshot() }
      default:
        throw new Error(`Claude Code does not support ${command.type}`)
    }
  }
  private validateModel(provider: string, id: string): void {
    if (
      !connections(this.config).some((connection) => connection.id === provider) ||
      !this.models.some((model) => model.value === id || model.resolvedModel === id)
    )
      throw new Error('Claude model is unavailable')
  }
  /** Keeps the email and plan the SDK reported for a subscription connection. */
  private async rememberIdentity(id: string, email?: string, plan?: string): Promise<void> {
    if (!email) return
    const label = plan ? planLabel(plan) : undefined
    if (id === DEFAULT_CONNECTION) {
      if (this.config.apiKey || (this.config.email === email && this.config.plan === label)) return
      this.config.email = email
      if (label) this.config.plan = label
    } else {
      const entry = this.config.accounts?.find((item) => item.id === id)
      if (!entry || (entry.email === email && entry.plan === label)) return
      entry.email = email
      if (label) entry.plan = label
    }
    await saveConfig(this.options.storage, this.config)
  }
  /** The connection this session runs on: its own binding while it still exists. */
  private connection(): string {
    const bound = this.reference?.connection
    return bound && connections(this.config).some((item) => item.id === bound)
      ? bound
      : activeConnection(this.config)
  }
  /**
   * Moves this session's next queries to another connection, only between turns. Without a
   * session (the configuration host) it changes the default for new sessions instead.
   */
  private async useConnection(id: string): Promise<void> {
    if (this.connection() === id) return
    this.assertIdle()
    if (this.reference) {
      this.reference.connection = id
      await this.store.save(this.reference)
    } else {
      this.config.active = id
      await saveConfig(this.options.storage, this.config)
    }
    await this.stopQuery()
    await this.initialize()
  }
  private async addAccount(): Promise<void> {
    this.assertIdle()
    const id = newConnectionId('account')
    await prepareAccountHome(this.options.storage, id)
    await this.login(id, 'browser')
  }
  private async removeConnection(id: string): Promise<void> {
    this.assertIdle()
    const config = await readConfig(this.options.storage)
    if (id === DEFAULT_CONNECTION) {
      if (!config.apiKey) await this.signOut(id).catch(() => undefined)
      delete config.apiKey
      delete config.baseUrl
      delete config.email
      delete config.plan
    } else if (config.accounts?.some((item) => item.id === id)) {
      await this.signOut(id).catch(() => undefined)
      config.accounts = config.accounts.filter((item) => item.id !== id)
      await removeAccountHome(this.options.storage, id)
    } else if (config.apis?.some((item) => item.id === id)) {
      config.apis = config.apis.filter((item) => item.id !== id)
    } else throw new Error('Unknown Claude connection')
    if (config.active === id) delete config.active
    this.config = config
    await saveConfig(this.options.storage, config)
    await this.stopQuery()
    await this.initialize()
  }
  /** The official CLI clears the keychain item that belongs to this configuration home. */
  private signOut(id: string): Promise<void> {
    const env = connectionEnvironment(
      this.options.storage,
      { ...this.config, apiKey: undefined },
      id
    )
    delete env.ANTHROPIC_API_KEY
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.options.executable ?? bundledClaudeExecutable(),
        ['auth', 'logout'],
        {
          env,
          cwd: this.options.storage.cache,
          stdio: 'ignore'
        }
      )
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Claude auth logout exited (${code})`))
      )
    })
  }
  private async catalog(
    options: Omit<ProjectCatalogCommand, 'type'>,
    unpaged = false
  ): Promise<HostResult> {
    return {
      kind: 'project-catalog',
      catalog: await readClaudeCatalog(this.store, {
        ...options,
        unpaged,
        activeId: this.snapshot.sessionId,
        activeCwd: this.snapshot.project?.path
      })
    }
  }
  private async search(
    command: Extract<HostCommand, { type: 'session:search' | 'project:search' }>
  ): Promise<HostResult> {
    const result = await this.catalog(command, true)
    if (result.kind !== 'project-catalog') throw new Error('Catalog result missing')
    const matches = (text: string) => text.toLowerCase().includes(command.query.toLowerCase())
    const metadata = { truncated: false, skippedDirectories: 0, skippedEntries: 0 }
    if (command.type === 'project:search') {
      const items = result.catalog.projects
        .filter((project) => matches(project.name) || matches(project.path))
        .map((project) => ({
          cwd: project.path,
          projectName: project.name,
          available: !project.error
        }))
      return {
        kind: 'project-search',
        result: {
          ...metadata,
          items: items.slice(0, command.limit),
          total: items.length,
          truncated: items.length > command.limit
        }
      }
    }
    const items = result.catalog.projects.flatMap((project) =>
      project.sessions
        .filter((session) => matches(session.title))
        .map((session) => ({
          id: session.id,
          title: session.title,
          sessionPath: session.path,
          cwd: project.path,
          projectName: project.name,
          modified: session.modified
        }))
    )
    return {
      kind: 'session-search',
      result: {
        ...metadata,
        items: items.slice(0, command.limit),
        total: items.length,
        truncated: items.length > command.limit
      }
    }
  }
  private async loadMcp(): Promise<void> {
    try {
      const content = await readFile(join(this.options.storage.config, 'desktop-mcp.json'), 'utf8')
      const raw = JSON.parse(content) as Record<string, unknown>
      this.userMcp = Object.fromEntries(
        Object.entries(raw).map(([id, server]) => [id, mcpServerSchema.parse(server)])
      )
      this.mcpRevision = createHash('sha256').update(content).digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.userMcp = {}
      this.mcpRevision = '0'
    }
  }
  private async saveMcp(): Promise<void> {
    const content = JSON.stringify(this.userMcp, null, 2)
    await writeFile(join(this.options.storage.config, 'desktop-mcp.json'), content, { mode: 0o600 })
    this.mcpRevision = createHash('sha256').update(content).digest('hex')
  }
  private async mcpSnapshot(): Promise<McpSnapshot> {
    const statuses = (await this.native?.mcpServerStatus()) ?? []
    return {
      revision: this.mcpRevision,
      writable: true,
      servers: Object.entries(this.userMcp).map(([id, server]) => {
        const status = statuses.find((status) => status.name === id)
        return {
          id,
          transport: server.url ? 'http' : 'stdio',
          command: server.command,
          args: server.args,
          url: server.url,
          envKeys: Object.keys(server.env ?? {}),
          headerKeys: Object.keys(server.headers ?? {}),
          enabled: !server.disabled,
          editable: true,
          status: server.disabled
            ? 'disabled'
            : status?.status === 'connected'
              ? 'connected'
              : status?.status === 'needs-auth'
                ? 'needs-auth'
                : status?.status === 'pending'
                  ? 'connecting'
                  : 'disconnected',
          toolCount: Math.min(status?.tools?.length ?? 0, 128)
        }
      })
    }
  }
  private async login(provider: string, method: string): Promise<void> {
    const existing = connections(this.config).find((item) => item.id === provider)
    const added = !existing && /^claude-[a-z0-9]{6,16}$/.test(provider)
    if (method !== 'browser' || (!added && existing?.kind === 'api') || (!existing && !added))
      throw new Error('Claude supports Anthropic browser login')
    if (this.authProcess) throw new Error('Claude login is already running')
    // Official auth command uses only app-owned configuration; no credential import.
    const home =
      provider === DEFAULT_CONNECTION
        ? this.options.storage.config
        : await prepareAccountHome(this.options.storage, provider)
    this.snapshot.login = { phase: 'starting', providerId: provider }
    this.publish()
    const child = spawn(this.options.executable ?? bundledClaudeExecutable(), ['auth', 'login'], {
      env: claudeEnvironment(this.options.storage, {}, process.env, home),
      cwd: this.options.storage.cache,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.authProcess = child
    let output = ''
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_000)
      const url = officialAuthUrl(output)
      if (url && this.snapshot.login.phase !== 'browser') {
        this.snapshot.login = {
          phase: 'browser',
          providerId: provider,
          url,
          instructions: 'Complete the official Claude login in your browser.'
        }
        this.options.post({ type: 'event', event: 'open-external', data: { url } })
        this.publish()
      }
    }
    const abandon = async (): Promise<void> => {
      if (added) await removeAccountHome(this.options.storage, provider).catch(() => undefined)
    }
    child.stdout?.on('data', receive)
    child.stderr?.on('data', receive)
    child.once('error', (error) => {
      this.authProcess = undefined
      void abandon()
      this.snapshot.login = { phase: 'error', providerId: provider, message: error.message }
      this.publish()
    })
    child.once('exit', (code) => {
      this.authProcess = undefined
      if (this.disposed) return
      void (async () => {
        if (code !== 0) throw new Error(`Claude auth login exited (${code})`)
        this.assertIdle()
        const config = await readConfig(this.options.storage)
        if (provider === DEFAULT_CONNECTION) {
          delete config.apiKey
          delete config.baseUrl
        } else if (added) config.accounts = [...(config.accounts ?? []), { id: provider }]
        config.active = provider
        this.config = config
        await saveConfig(this.options.storage, config)
        // Signing in from a session's composer moves that session to the new login too.
        if (this.reference) {
          this.reference.connection = provider
          await this.store.save(this.reference)
        }
        await this.stopQuery()
        await this.initialize()
        const account = this.snapshot.accounts.find((item) => item.id === provider)
        if (!account?.connected)
          throw new Error('Claude SDK did not confirm authenticated account status')
        const duplicate = account.email
          ? this.snapshot.accounts.find(
              (item) => item.id !== provider && item.email === account.email
            )
          : undefined
        if (duplicate && added) {
          await this.removeConnection(provider)
          await this.useConnection(duplicate.id)
          this.snapshot.login = {
            phase: 'error',
            providerId: duplicate.id,
            message: `${account.email} 已经添加过，已切换到这个账号`
          }
        } else this.snapshot.login = { phase: 'success', providerId: provider }
        this.publish()
      })().catch(async (error) => {
        if (added && !this.config.accounts?.some((item) => item.id === provider)) await abandon()
        this.snapshot.login = { phase: 'error', providerId: provider, message: errorText(error) }
        this.publish()
      })
    })
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.slice(0, 253)
  } catch {
    return url.slice(0, 80)
  }
}

/** The SDK reports plans as identifiers such as `max` or `claude_pro`. */
function planLabel(plan: string): string {
  const name = plan.replace(/^claude_/, '').toLowerCase()
  return (
    { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' }[name] ??
    plan.slice(0, 40)
  )
}
