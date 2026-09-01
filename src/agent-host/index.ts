import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeResult,
  ExtensionUIContext,
  InlineExtension,
  ModelRuntime,
  SessionManager,
  SessionStartEvent
} from '@earendil-works/pi-coding-agent'
import type {
  AuthInteraction,
  AuthPrompt,
  AssistantMessage,
  CredentialInfo,
  Message,
  Model,
  Provider,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import {
  AGENT_ENGINE,
  type AccountSummary,
  type AgentSnapshot,
  type AgentStatePatch,
  type ApprovalRequest,
  type ConversationNode,
  type HostMessage,
  type HostRequest,
  type HostResult,
  type LoginMethod,
  type LoginPrompt,
  type LoginStatus,
  type ModelSummary,
  type PermissionMode,
  type SessionStatus,
  type SessionSummary,
  type ToolIntent,
  type ToolStatus,
  type UsageMetrics
} from '../shared/contracts'
import { hostResultMatchesCommand } from '../shared/command-result'
import { hostRequestSchema } from '../shared/schemas'
import { projectedSessionStatus, projectSessionTitle } from '../shared/session-presentation'
import { createStatePatch } from '../shared/state-patch'
import { resolveAgentDirectory } from '../main/e2e-temp-directory'
import { ApprovalRegistry } from './approval-registry'
import { ConversationProjection } from './conversation-projection'
import { LoginPromptRegistry } from './login-prompt-registry'
import { PatchBatcher } from './patch-batcher'
import { clearFollowUpQueue } from './queue-state'
import { SerialExecutor } from './serial-executor'
import {
  runPreparedSessionReplacement,
  runSessionReplacement,
  usesSessionTransition
} from './session-transition'
import { buildStreamingPatch } from './streaming-patch'
import { requiresToolApproval, ToolExecutionState } from './tool-execution-state'
import {
  applyExactModelSelection,
  completeLoginSuccess,
  createOneShotRecoveryModelSelector,
  hasPersistentTranscript,
  prepareNewSessionModelSelection,
  prepareSessionRecoveryModelSelection,
  projectSessionModelPin,
  type ExactModelSelection,
  type PreparedModelSelection,
  type SessionModelMutationTarget,
  type SessionModelProjection
} from './session-model'

const AGENT_DIR = resolveAgentDirectory({
  e2eMode: process.env.PI_DESKTOP_E2E === '1',
  override: process.env.PI_DESKTOP_E2E_AGENT_DIR
})
const MULTI_LOGIN_CONFIG = join(AGENT_DIR, 'pi-multi-login.json')
process.env.PI_CODING_AGENT_DIR = AGENT_DIR
process.env.PI_MULTI_LOGIN_CONFIG = MULTI_LOGIN_CONFIG
delete process.env.PI_CODING_AGENT_SESSION_DIR

function projectSessionDirectory(cwd: string): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`
  return join(AGENT_DIR, 'sessions', safePath)
}
const ALIAS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_TOOL_OUTPUT = 12_000
const MESSAGE_UPDATE_BATCH_MS = 32

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

type ApprovalMetadata = Omit<ApprovalRequest, 'id' | 'generation'>

type RunTiming = {
  llmStartedAt?: number
  firstTokenSeen: boolean
  llmDurationMs: number
  firstTokenSamples: number[]
  outputTokens: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function send(message: HostMessage): void {
  process.parentPort.postMessage(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPiMessage(value: unknown): value is Message {
  if (!isRecord(value) || typeof value.timestamp !== 'number') return false
  if (value.role === 'user')
    return typeof value.content === 'string' || Array.isArray(value.content)
  if (value.role === 'assistant') return Array.isArray(value.content)
  return (
    value.role === 'toolResult' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.isError === 'boolean' &&
    Array.isArray(value.content)
  )
}

function isConcreteModel(model: { provider: string; id: string } | undefined): boolean {
  return Boolean(model && model.provider !== 'unknown' && model.id !== 'unknown')
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } => {
      return isRecord(item) && item.type === 'text' && typeof item.text === 'string'
    })
    .map((item) => item.text)
    .join('\n')
}

function toolIntent(name: string): ToolIntent {
  if (name === 'bash' || name === 'powershell') return 'terminal'
  if (name === 'read' || name === 'ls') return 'read'
  if (name === 'write' || name === 'edit') return 'diff'
  if (name === 'grep' || name === 'find') return 'search'
  if (name === 'web' || name.includes('browser')) return 'web'
  return 'generic'
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function toolPresentation(name: string, rawArgs: unknown): { title: string; detail: string } {
  const args = isRecord(rawArgs) ? rawArgs : {}
  const command = stringArg(args, 'command')
  const path = stringArg(args, 'path', 'filePath')
  const pattern = stringArg(args, 'pattern', 'query')
  const title =
    name === 'bash' || name === 'powershell'
      ? command?.split('\n')[0] || '运行命令'
      : name === 'read'
        ? `读取 ${path ?? '文件'}`
        : name === 'ls'
          ? `列出 ${path ?? '目录'}`
          : name === 'write'
            ? `写入 ${path ?? '文件'}`
            : name === 'edit'
              ? `编辑 ${path ?? '文件'}`
              : name === 'grep' || name === 'find'
                ? `搜索 ${pattern ?? path ?? ''}`.trim()
                : name

  let detail = ''
  try {
    detail = JSON.stringify(args, null, 2)
  } catch {
    detail = String(rawArgs ?? '')
  }
  return { title, detail }
}

function multiLoginExtensionPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve('@hank-warren/pi-multi-login/package.json')), 'index.ts')
  } catch (error) {
    console.warn(`无法定位 pi-multi-login：${errorMessage(error)}`)
    return undefined
  }
}

function codexLoopbackAvailable(): Promise<boolean> {
  const host = process.env.PI_OAUTH_CALLBACK_HOST || '127.0.0.1'
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (available: boolean): void => {
      if (settled) return
      settled = true
      resolve(available)
    }
    server.once('error', () => finish(false))
    server.listen(1455, host, () => {
      server.close((error) => finish(!error))
    })
  })
}

class PiDesktopHost {
  private sdk: PiSdk | null = null
  private modelRuntime: ModelRuntime | null = null
  private runtime: AgentSessionRuntime | null = null
  private projectPath: string | null = null
  private permissionMode: PermissionMode = 'ask'
  private activeExplicitModel: ExactModelSelection | null = null
  private pendingNewSessionModel: ExactModelSelection | null = null
  private pendingNewSessionRuntimeModel: Model<string> | null = null
  private accounts: AccountSummary[] = []
  private models: ModelSummary[] = []
  private sessions: SessionSummary[] = []
  private login: LoginStatus = { phase: 'idle' }
  private loginPrompt: LoginPrompt | null = null
  private lastError: string | undefined
  private initialized = false
  private initializing: Promise<void> | null = null
  private unsubscribeSession: (() => void) | undefined
  private sessionGeneration = 0
  private sessionInvalidationSequence = 0
  private revision = 0
  private publishedSnapshot: AgentSnapshot | null = null
  private patchesSuspended = false
  private toolExecution = new ToolExecutionState()
  private conversationProjection = new ConversationProjection()
  private approvalRegistry = new ApprovalRegistry((change) => {
    const state =
      change.status === 'pending'
        ? this.toolExecution.approvalPending(change.request.toolCallId)
        : change.status === 'allowed'
          ? this.toolExecution.approvalAllowed(change.request.toolCallId, Date.now())
          : this.toolExecution.approvalBlocked(change.request.toolCallId)
    this.updateToolNode(change.request.toolCallId, state)
    this.emitPatch()
  })
  private loginPrompts = new LoginPromptRegistry((prompt) => {
    this.loginPrompt = prompt
    this.emitPatch()
  })
  private loginAbort: AbortController | null = null
  private approvalMetadata: ApprovalMetadata | null = null
  private timing: RunTiming | null = null
  private lastTiming: RunTiming | null = null
  private followUp: string[] = []
  private sessionTransition = new SerialExecutor()
  private modelMutationInProgress = false
  private pendingPromptsBySession = new Map<string, number>()
  private patchBatcher = new PatchBatcher(() => this.emitStreamingPatch(), MESSAGE_UPDATE_BATCH_MS)
  private pendingStreamingMessage: AssistantMessage | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      mkdirSync(AGENT_DIR, { recursive: true })
      this.sdk = await import('@earendil-works/pi-coding-agent')
      this.modelRuntime = await this.sdk.ModelRuntime.create({
        authPath: join(AGENT_DIR, 'auth.json'),
        modelsPath: join(AGENT_DIR, 'models.json'),
        allowModelNetwork: false
      })
      await this.refreshAuthProjection()
      this.initialized = true
      this.emitSnapshot()
    })()
    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  async handle(request: HostRequest): Promise<HostResult> {
    await this.initialize()
    if (usesSessionTransition(request)) {
      return this.sessionTransition.run(() => this.handleInitialized(request))
    }
    return this.handleInitialized(request)
  }

  private async handleInitialized(request: HostRequest): Promise<HostResult> {
    if (request.type !== 'bootstrap' && request.type !== 'state:get') this.lastError = undefined

    switch (request.type) {
      case 'bootstrap':
      case 'state:get':
        break
      case 'project:open':
        await this.openProject(request.cwd)
        break
      case 'session:new':
        await this.newSession(
          'providerId' in request ? request.providerId : undefined,
          'modelId' in request ? request.modelId : undefined
        )
        break
      case 'session:open':
        await this.openSession(request.path)
        break
      case 'prompt:send':
        this.sendPrompt(request.text)
        break
      case 'prompt:abort':
        await this.abortPrompt()
        break
      case 'queue:clear':
        this.clearQueue()
        break
      case 'permission:set':
        this.permissionMode = request.mode
        break
      case 'permission:respond':
        this.resolveApproval(request.approvalId, request.allow)
        break
      case 'account:login':
        await this.startLogin(request.providerId, request.method)
        break
      case 'account:login:respond':
        this.resolveLoginPrompt(request.promptId, request.value)
        break
      case 'account:alias:add':
        await this.addAlias(request.slug)
        break
      case 'model:set':
        await this.setModel(request.providerId, request.modelId)
        break
    }

    if (
      request.type === 'bootstrap' ||
      request.type === 'state:get' ||
      request.type === 'project:open' ||
      request.type === 'session:new' ||
      request.type === 'session:open'
    ) {
      return { kind: 'snapshot', snapshot: this.emitSnapshot() }
    }
    const snapshot = this.emitPatch()
    return {
      kind: 'ack',
      sessionId: snapshot.sessionId,
      generation: snapshot.generation,
      revision: snapshot.revision
    }
  }

  private permissionExtension(): InlineExtension {
    return {
      name: 'pi-desktop-permissions',
      factory: (pi) => {
        pi.on('tool_call', async (event, ctx) => {
          if (this.permissionMode === 'open') return undefined
          if (!['bash', 'powershell', 'write', 'edit'].includes(event.toolName)) return undefined

          const presentation = toolPresentation(event.toolName, event.input)
          this.approvalMetadata = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            intent: toolIntent(event.toolName),
            title: presentation.title,
            detail: presentation.detail
          }
          try {
            const allowed = await ctx.ui.confirm('允许 Pi 执行此操作？', presentation.detail)
            if (!allowed) return { block: true, reason: '用户拒绝了这次工具调用' }
            return undefined
          } finally {
            this.approvalMetadata = null
          }
        })
      }
    }
  }

  private createUiContext(): ExtensionUIContext {
    const unsupported = async (): Promise<undefined> => undefined
    return {
      select: unsupported,
      confirm: (_title, message, options) => this.requestApproval(message, options?.signal),
      input: unsupported,
      notify: (message, type) => {
        if (type === 'error') this.lastError = message
        this.emitPatch()
      },
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => '',
      editor: unsupported,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      get theme() {
        return undefined as never
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Pi Desktop 不提供 TUI 主题切换' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined
    }
  }

  private async createRuntime(
    sessionManager: SessionManager,
    projectPath: string,
    recoveryModel: PreparedModelSelection<Model<string>> | null = null
  ): Promise<AgentSessionRuntime> {
    if (!this.sdk || !this.modelRuntime) {
      throw new Error('Agent Host 尚未选择工作区')
    }
    const sdk = this.sdk
    const fixedModelRuntime = this.modelRuntime
    const extensionPath = multiLoginExtensionPath()
    const selectModelOverride = createOneShotRecoveryModelSelector(recoveryModel)
    const createRuntime = async ({
      cwd,
      sessionManager: nextManager,
      sessionStartEvent
    }: {
      cwd: string
      agentDir: string
      sessionManager: SessionManager
      sessionStartEvent?: SessionStartEvent
    }): Promise<CreateAgentSessionRuntimeResult> => {
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir: AGENT_DIR,
        modelRuntime: fixedModelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: extensionPath ? [extensionPath] : [],
          extensionFactories: [this.permissionExtension()]
        }
      })
      const entries = nextManager.buildContextEntries()
      const context = nextManager.buildSessionContext()
      const emptySessionSelection =
        entries.length === 0 && this.pendingNewSessionModel && this.pendingNewSessionRuntimeModel
          ? {
              identity: this.pendingNewSessionModel,
              runtimeModel: this.pendingNewSessionRuntimeModel
            }
          : null
      const selectedOverride = selectModelOverride(emptySessionSelection)
      const projected = projectSessionModelPin(
        {
          header: nextManager.getHeader(),
          entries,
          contextModel: context.model,
          explicitModel: entries.length === 0 ? (selectedOverride?.identity ?? null) : null
        },
        this.accounts,
        this.models
      )
      const selected = selectedOverride
        ? selectedOverride.runtimeModel
        : projected.identity
          ? fixedModelRuntime.getAvailableSnapshot().find((model) => {
              return (
                model.provider === projected.identity?.providerId &&
                model.id === projected.identity.modelId
              )
            })
          : undefined
      const result = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: nextManager,
        sessionStartEvent,
        model: selected,
        tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
      })
      return { ...result, services, diagnostics: services.diagnostics }
    }

    return sdk.createAgentSessionRuntime(createRuntime, {
      cwd: projectPath,
      agentDir: AGENT_DIR,
      sessionManager
    })
  }

  private async openProject(cwd: string): Promise<void> {
    const stats = statSync(cwd)
    if (!stats.isDirectory()) throw new Error('所选工作区不是文件夹')

    if (!this.sdk) throw new Error('Pi SDK 尚未加载')
    const sessionManager = this.sdk.SessionManager.continueRecent(cwd, projectSessionDirectory(cwd))
    const generationBeforeReplacement = this.sessionGeneration
    await runPreparedSessionReplacement({
      generationBeforeReplacement,
      prepare: () => this.createRuntime(sessionManager, cwd),
      commit: async (runtime) => {
        await this.disposeRuntime()
        this.projectPath = cwd
        this.activeExplicitModel = null
        this.pendingNewSessionModel = null
        this.pendingNewSessionRuntimeModel = null
        this.runtime = runtime
        this.configureRuntime(runtime)
        await this.bindSession()
        await this.refreshAuthProjection()
        await this.refreshSessions()
      },
      readGeneration: () => this.sessionGeneration,
      publishSnapshot: () => {
        this.emitSnapshot()
      }
    })
  }

  private configureRuntime(runtime: AgentSessionRuntime): void {
    runtime.setBeforeSessionInvalidate(() => {
      this.sessionInvalidationSequence += 1
    })
    runtime.setRebindSession(async () => this.bindSession())
  }

  private async recoverInvalidatedSession(
    sessionManager: SessionManager,
    projectPath: string,
    recoveryModel: PreparedModelSelection<Model<string>> | null
  ): Promise<void> {
    this.pendingNewSessionModel = null
    this.pendingNewSessionRuntimeModel = null
    const runtime = await this.createRuntime(sessionManager, projectPath, recoveryModel)
    this.runtime = runtime
    this.configureRuntime(runtime)
    await this.bindSession()
  }

  private async clearSessionAfterRecoveryFailure(
    invalidatedRuntime: AgentSessionRuntime
  ): Promise<void> {
    const failedRecoveryRuntime = this.runtime
    this.abandonRuntime()
    this.projectPath = null
    if (failedRecoveryRuntime && failedRecoveryRuntime !== invalidatedRuntime) {
      try {
        await failedRecoveryRuntime.dispose()
      } catch (error) {
        console.error('Failed to dispose an incomplete recovery runtime', error)
      }
    }
  }

  private async bindSession(): Promise<void> {
    const session = this.runtime?.session
    if (!session) return
    this.rejectApprovals(true, 'session-switch')
    this.sessionGeneration += 1
    const generation = this.sessionGeneration
    this.resetPublishedState()
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.toolExecution.clear()
    this.followUp = [...session.getFollowUpMessages()]
    this.lastTiming = null
    this.timing = null

    await session.bindExtensions({
      uiContext: this.createUiContext(),
      mode: 'rpc',
      abortHandler: () => void session.abort(),
      onError: (error) => {
        this.lastError = `${error.extensionPath}: ${error.error}`
        this.emitPatch()
      }
    })

    this.unsubscribeSession = session.subscribe((event) => {
      if (generation !== this.sessionGeneration) return
      this.handleSessionEvent(event)
    })
    const projection = this.projectActiveSessionModel(session, this.pendingNewSessionModel)
    this.activeExplicitModel = projection.identity
    this.pendingNewSessionModel = null
    this.pendingNewSessionRuntimeModel = null
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const now = Date.now()
    switch (event.type) {
      case 'agent_start':
        this.timing = {
          firstTokenSeen: false,
          llmDurationMs: 0,
          firstTokenSamples: [],
          outputTokens: 0
        }
        break
      case 'message_start':
        if (isPiMessage(event.message)) {
          this.projectEventMessage(event.message, event.message.role === 'assistant')
        }
        if (event.message.role === 'assistant' && this.timing) {
          this.timing.llmStartedAt = now
          this.timing.firstTokenSeen = false
        }
        break
      case 'message_update': {
        const update = event.assistantMessageEvent
        if (
          this.timing &&
          this.timing.llmStartedAt &&
          !this.timing.firstTokenSeen &&
          (update.type === 'text_delta' || update.type === 'thinking_delta') &&
          update.delta.length > 0
        ) {
          this.timing.firstTokenSeen = true
          this.timing.firstTokenSamples.push(now - this.timing.llmStartedAt)
        }
        if (isPiMessage(event.message) && event.message.role === 'assistant') {
          this.pendingStreamingMessage = event.message
        }
        this.schedulePatch()
        return
      }
      case 'message_end':
        this.pendingStreamingMessage = null
        if (isPiMessage(event.message)) this.projectEventMessage(event.message, false)
        if (event.message.role === 'assistant' && this.timing) {
          if (this.timing.llmStartedAt) this.timing.llmDurationMs += now - this.timing.llmStartedAt
          this.timing.outputTokens += event.message.usage.output
          this.timing.llmStartedAt = undefined
        }
        if (event.message.role === 'assistant' && event.message.errorMessage) {
          this.lastError = event.message.errorMessage
        }
        break
      case 'tool_execution_start':
        this.updateToolNode(
          event.toolCallId,
          this.toolExecution.start(
            event.toolCallId,
            requiresToolApproval(this.permissionMode, event.toolName),
            now
          )
        )
        break
      case 'tool_execution_update': {
        const output = textFromContent(
          isRecord(event.partialResult) ? event.partialResult.content : event.partialResult
        )
        const state = this.toolExecution.get(event.toolCallId) ?? { status: 'running' as const }
        this.updateToolNode(
          event.toolCallId,
          this.toolOutputFields(output, state.status, state.durationMs)
        )
        break
      }
      case 'tool_execution_end': {
        const state = this.toolExecution.end(event.toolCallId, event.isError, now)
        this.updateToolNode(
          event.toolCallId,
          this.toolOutputFields(
            textFromContent(isRecord(event.result) ? event.result.content : event.result),
            state.status,
            state.durationMs
          )
        )
        break
      }
      case 'agent_settled':
        if (this.timing) this.lastTiming = { ...this.timing }
        this.timing = null
        this.flushPatch()
        void this.refreshSessions(this.sessionGeneration).then((refreshed) => {
          if (refreshed) this.emitPatch()
        })
        return
      case 'queue_update':
        this.followUp = [...event.followUp]
        break
      case 'entry_appended':
      case 'session_info_changed':
        void this.refreshSessions(this.sessionGeneration).then((refreshed) => {
          if (refreshed) this.emitPatch()
        })
        return
    }
    if (event.type === 'message_end') this.flushPatch()
    else this.emitPatch()
  }

  private async refreshSessions(expectedGeneration?: number): Promise<boolean> {
    if (!this.projectPath) {
      this.sessions = []
      return true
    }
    const current = this.runtime?.session.sessionFile
    if (!this.sdk) return false
    const listed = await this.sdk.SessionManager.list(
      this.projectPath,
      projectSessionDirectory(this.projectPath)
    )
    if (expectedGeneration !== undefined && expectedGeneration !== this.sessionGeneration) {
      return false
    }
    this.sessions = listed.map((session) => ({
      id: session.id,
      path: session.path,
      title: projectSessionTitle(session),
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
      active: session.path === current,
      status: 'idle'
    }))
    return true
  }

  private async refreshAuthProjection(): Promise<void> {
    if (!this.modelRuntime) return
    const providers = this.modelRuntime.getProviders()
    const credentials = await this.modelRuntime.listCredentials()
    const stored = new Map(credentials.map((item) => [item.providerId, item]))
    const relevant = providers.filter((provider) => {
      return (
        provider.id === 'openai-codex' ||
        provider.id.startsWith('openai-codex-') ||
        stored.has(provider.id)
      )
    })
    const checks = await Promise.all(
      relevant.map(
        async (provider) => [provider.id, await this.modelRuntime?.checkAuth(provider.id)] as const
      )
    )
    const checked = new Map(checks)
    this.accounts = relevant.map((provider) =>
      this.accountSummary(provider, stored.get(provider.id), Boolean(checked.get(provider.id)))
    )

    const available = await this.modelRuntime.getAvailable()
    this.models = available.map((model) => this.modelSummary(model))
  }

  private accountSummary(
    provider: Provider,
    credential: CredentialInfo | undefined,
    connected: boolean
  ): AccountSummary {
    return {
      id: provider.id,
      name: provider.name,
      authType: credential?.type ?? (provider.auth.oauth ? 'oauth' : 'api_key'),
      connected,
      subscription: this.modelRuntime?.isUsingSubscription(provider.id) ?? false,
      alias: provider.id.startsWith('openai-codex-')
    }
  }

  private modelSummary(model: Model<string>): ModelSummary {
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning
    }
  }

  private async newSession(providerId?: string, modelId?: string): Promise<void> {
    if (!this.runtime) throw new Error('请先选择工作区')
    if (!this.projectPath) throw new Error('请先选择工作区')
    await this.refreshAuthProjection()
    const prepared = prepareNewSessionModelSelection(
      this.accounts,
      this.models,
      providerId,
      modelId,
      (selection) =>
        this.modelRuntime
          ?.getAvailableSnapshot()
          .find(
            (model) => model.provider === selection.providerId && model.id === selection.modelId
          )
    )
    const generationBeforeReplacement = this.sessionGeneration
    const invalidationBeforeReplacement = this.sessionInvalidationSequence
    const invalidatedRuntime = this.runtime
    const outgoingSessionManager = invalidatedRuntime.session.sessionManager
    const recoveryModel = prepareSessionRecoveryModelSelection(
      this.activeExplicitModel,
      isConcreteModel(invalidatedRuntime.session.model) ? invalidatedRuntime.session.model! : null,
      hasPersistentTranscript(outgoingSessionManager.buildContextEntries())
    )
    this.pendingNewSessionModel = prepared?.identity ?? null
    this.pendingNewSessionRuntimeModel = prepared?.runtimeModel ?? null
    const projectPath = this.projectPath
    try {
      await runSessionReplacement({
        generationBeforeReplacement,
        invalidationBeforeReplacement,
        replaceSession: () => invalidatedRuntime.newSession(),
        refreshSessions: () => this.refreshSessions(),
        readGeneration: () => this.sessionGeneration,
        readInvalidation: () => this.sessionInvalidationSequence,
        recoverInvalidatedSession: () =>
          this.recoverInvalidatedSession(outgoingSessionManager, projectPath, recoveryModel),
        clearSessionAfterRecoveryFailure: () =>
          this.clearSessionAfterRecoveryFailure(invalidatedRuntime),
        publishSnapshot: () => {
          this.emitSnapshot()
        }
      })
    } finally {
      this.pendingNewSessionModel = null
      this.pendingNewSessionRuntimeModel = null
    }
  }

  private async openSession(path: string): Promise<void> {
    if (!this.runtime || !this.projectPath) throw new Error('请先选择工作区')
    if (!this.sdk) throw new Error('Pi SDK 尚未加载')
    const sessions = await this.sdk.SessionManager.list(
      this.projectPath,
      projectSessionDirectory(this.projectPath)
    )
    if (!sessions.some((session) => session.path === path)) throw new Error('会话不属于当前工作区')
    const generationBeforeReplacement = this.sessionGeneration
    const invalidationBeforeReplacement = this.sessionInvalidationSequence
    const invalidatedRuntime = this.runtime
    const outgoingSessionManager = invalidatedRuntime.session.sessionManager
    const recoveryModel = prepareSessionRecoveryModelSelection(
      this.activeExplicitModel,
      isConcreteModel(invalidatedRuntime.session.model) ? invalidatedRuntime.session.model! : null,
      hasPersistentTranscript(outgoingSessionManager.buildContextEntries())
    )
    const projectPath = this.projectPath
    await runSessionReplacement({
      generationBeforeReplacement,
      invalidationBeforeReplacement,
      replaceSession: () => invalidatedRuntime.switchSession(path),
      refreshSessions: () => this.refreshSessions(),
      readGeneration: () => this.sessionGeneration,
      readInvalidation: () => this.sessionInvalidationSequence,
      recoverInvalidatedSession: () =>
        this.recoverInvalidatedSession(outgoingSessionManager, projectPath, recoveryModel),
      clearSessionAfterRecoveryFailure: () =>
        this.clearSessionAfterRecoveryFailure(invalidatedRuntime),
      publishSnapshot: () => {
        this.emitSnapshot()
      }
    })
  }

  private sendPrompt(rawText: string): void {
    const session = this.runtime?.session
    if (!session) throw new Error('请先选择工作区')
    if (this.modelMutationInProgress) throw new Error('正在切换模型，请稍后再发送')
    const text = rawText.trim()
    if (!text) throw new Error('请输入任务内容')
    const projection = this.projectActiveSessionModel(session)
    if (!projection.identity) {
      throw new Error(
        projection.composeBlockReason === 'login-required' ? '请先登录 Codex' : '请先选择模型'
      )
    }
    if (
      projection.modelAvailability !== 'available' ||
      session.model?.provider !== projection.identity.providerId ||
      session.model?.id !== projection.identity.modelId
    ) {
      throw new Error(
        projection.pinned ? '此会话钉定的模型当前不可用' : '所选模型当前不可用，请重新选择'
      )
    }

    const behavior = session.isStreaming ? 'followUp' : undefined
    const sessionId = session.sessionManager.getSessionId()
    this.pendingPromptsBySession.set(
      sessionId,
      (this.pendingPromptsBySession.get(sessionId) ?? 0) + 1
    )
    void session
      .prompt(text, {
        ...(behavior ? { streamingBehavior: behavior } : {}),
        source: 'rpc'
      })
      .catch((error) => {
        this.lastError = errorMessage(error)
        this.emitPatch()
      })
      .finally(() => {
        const remaining = (this.pendingPromptsBySession.get(sessionId) ?? 1) - 1
        if (remaining > 0) this.pendingPromptsBySession.set(sessionId, remaining)
        else this.pendingPromptsBySession.delete(sessionId)
      })
  }

  private async abortPrompt(): Promise<void> {
    this.rejectApprovals(false, 'abort')
    await this.runtime?.session.abort()
  }

  private clearQueue(): void {
    const session = this.runtime?.session
    if (!session) throw new Error('请先选择工作区')
    this.followUp = clearFollowUpQueue(session)
  }

  private async setModel(providerId: string, modelId: string): Promise<void> {
    if (!this.modelRuntime) throw new Error('模型运行时尚未就绪')
    this.modelMutationInProgress = true
    try {
      const selection = await applyExactModelSelection(providerId, modelId, {
        readTarget: () => this.sessionModelMutationTarget(),
        refreshAuthProjection: () => this.refreshAuthProjection(),
        getAccounts: () => this.accounts,
        getModels: () => this.models,
        findAvailableModel: (identity) =>
          this.modelRuntime
            ?.getAvailableSnapshot()
            .find(
              (model) => model.provider === identity.providerId && model.id === identity.modelId
            ),
        applyModel: async (target, model) => {
          const current = this.sessionModelMutationTarget()
          const session = this.runtime?.session
          if (
            !current ||
            !session ||
            current.sessionId !== target.sessionId ||
            current.generation !== target.generation
          ) {
            throw new Error('会话已切换，请重新选择模型')
          }
          if (current.hasTranscript) {
            throw new Error('当前会话已有对话内容，不能原地切换模型')
          }
          if (current.busy || current.promptPending) {
            throw new Error('当前会话正在运行，不能切换模型')
          }
          await session.setModel(model)
        }
      })
      this.activeExplicitModel = selection
    } finally {
      this.modelMutationInProgress = false
    }
  }

  private requestApproval(message: string, signal?: AbortSignal): Promise<boolean> {
    const metadata = this.approvalMetadata
    if (!metadata) return Promise.resolve(false)
    if (signal?.aborted) {
      const state = this.toolExecution.approvalBlocked(metadata.toolCallId)
      this.updateToolNode(metadata.toolCallId, state)
      this.emitPatch()
      return Promise.resolve(false)
    }

    const id = randomUUID()
    const generation = this.sessionGeneration
    const request: ApprovalRequest = {
      ...metadata,
      id,
      generation,
      detail: message || metadata.detail
    }

    return this.approvalRegistry.request(request, signal)
  }

  private resolveApproval(id: string, allow: boolean): void {
    this.approvalRegistry.resolve(id, this.sessionGeneration, allow)
  }

  private rejectApprovals(silent: boolean, reason: 'abort' | 'session-switch'): void {
    const wasSuspended = this.patchesSuspended
    if (silent) this.patchesSuspended = true
    try {
      this.approvalRegistry.clear(this.sessionGeneration, reason)
    } finally {
      this.patchesSuspended = wasSuspended
    }
  }

  private async startLogin(providerId: string, method: LoginMethod): Promise<void> {
    if (!this.modelRuntime) throw new Error('登录运行时尚未就绪')
    const provider = this.modelRuntime.getProvider(providerId)
    if (!provider?.auth.oauth) throw new Error('该账号不支持 Pi OAuth 登录')

    let selectedMethod = method
    if (
      method === 'browser' &&
      providerId.startsWith('openai-codex') &&
      !(await codexLoopbackAvailable())
    ) {
      selectedMethod = 'device_code'
    }

    this.loginAbort?.abort()
    this.rejectLoginPrompts()
    const controller = new AbortController()
    this.loginAbort = controller
    this.login = { phase: 'starting', providerId }
    this.emitPatch()

    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (prompt) => this.handleAuthPrompt(providerId, selectedMethod, prompt),
      notify: (event) => {
        switch (event.type) {
          case 'auth_url':
            this.login = {
              phase: 'browser',
              providerId,
              url: event.url,
              instructions: event.instructions
            }
            send({ type: 'event', event: 'open-external', data: { url: event.url } })
            break
          case 'device_code':
            this.login = {
              phase: 'device_code',
              providerId,
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresInSeconds: event.expiresInSeconds
            }
            send({ type: 'event', event: 'open-external', data: { url: event.verificationUri } })
            break
          case 'info':
          case 'progress':
            this.login = { phase: 'waiting', providerId, message: event.message }
            break
        }
        this.emitPatch()
      }
    }

    void this.modelRuntime
      .login(providerId, 'oauth', interaction)
      .then(async () => {
        this.rejectLoginPrompts()
        await completeLoginSuccess(providerId, {
          refreshAuthProjection: () => this.refreshAuthProjection(),
          publishLogin: (login) => {
            this.login = login
          }
        })
        this.emitPatch()
      })
      .catch((error) => {
        this.rejectLoginPrompts()
        if (controller.signal.aborted) return
        this.login = { phase: 'error', providerId, message: errorMessage(error) }
        this.emitPatch()
      })
      .finally(() => {
        if (this.loginAbort === controller) this.loginAbort = null
      })
  }

  private handleAuthPrompt(
    providerId: string,
    method: LoginMethod,
    prompt: AuthPrompt
  ): Promise<string> {
    if (
      prompt.type === 'select' &&
      prompt.options.some((item) => item.id === 'browser') &&
      prompt.options.some((item) => item.id === 'device_code')
    ) {
      return Promise.resolve(method)
    }

    if (prompt.signal?.aborted) return Promise.resolve('')
    const id = randomUUID()
    const data: LoginPrompt = {
      id,
      providerId,
      type: prompt.type,
      message: prompt.message,
      ...('placeholder' in prompt ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === 'select' ? { options: [...prompt.options] } : {})
    }
    return this.loginPrompts.request(data, prompt.signal)
  }

  private resolveLoginPrompt(id: string, value?: string): void {
    this.loginPrompts.resolve(id, value)
  }

  private rejectLoginPrompts(): void {
    this.loginPrompts.clear()
  }

  private async addAlias(slug: string): Promise<void> {
    if (!this.runtime) throw new Error('请先选择工作区，再添加第二个 Codex 账号')
    const normalized = slug.trim()
    if (!ALIAS_SLUG.test(normalized)) throw new Error('账号别名只能使用小写字母、数字和单个连字符')
    const id = `openai-codex-${normalized}`
    if (this.modelRuntime?.getProvider(id)) throw new Error('这个账号别名已经存在')

    let document: Record<string, unknown> = {}
    if (existsSync(MULTI_LOGIN_CONFIG)) {
      const parsed: unknown = JSON.parse(readFileSync(MULTI_LOGIN_CONFIG, 'utf8'))
      if (isRecord(parsed)) document = parsed
    }
    const current = Array.isArray(document.aliases) ? document.aliases : []
    const aliases = [...current, { base: 'openai-codex', suffix: normalized }]
    const temporary = `${MULTI_LOGIN_CONFIG}.${randomUUID()}.tmp`
    mkdirSync(dirname(MULTI_LOGIN_CONFIG), { recursive: true })
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...document, aliases }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      renameSync(temporary, MULTI_LOGIN_CONFIG)
    } finally {
      rmSync(temporary, { force: true })
    }

    await this.runtime.session.reload()
    await this.refreshAuthProjection()
  }

  private projectMessages(session: AgentSession): ConversationNode[] {
    const messages = [...session.messages] as Message[]
    const streaming = session.agent.state.streamingMessage as Message | undefined
    if (streaming && !messages.includes(streaming)) messages.push(streaming)
    const results = new Map<string, ToolResultMessage>()
    for (const message of messages) {
      if (message.role === 'toolResult') results.set(message.toolCallId, message)
    }

    return messages.flatMap((message, messageIndex) => {
      if (message.role === 'user') return this.projectUserMessage(message, messageIndex)
      if (message.role === 'assistant') {
        return this.projectAssistantMessage(message, message === streaming, results)
      }
      return []
    })
  }

  private projectEventMessage(message: Message, streaming: boolean): void {
    if (message.role === 'assistant') {
      this.conversationProjection.replaceGroup(
        `assistant-message-${message.timestamp}`,
        this.projectAssistantMessage(message, streaming)
      )
      return
    }
    if (message.role === 'user') {
      const messages = (this.runtime?.session.messages ?? []) as Message[]
      const matchingIndex = messages.findIndex(
        (candidate) =>
          candidate === message ||
          (candidate.role === 'user' && candidate.timestamp === message.timestamp)
      )
      const messageIndex = matchingIndex >= 0 ? matchingIndex : messages.length
      this.conversationProjection.replaceGroup(
        `user-message-${message.timestamp}`,
        this.projectUserMessage(message, messageIndex)
      )
      return
    }
    this.updateToolNode(
      message.toolCallId,
      this.toolOutputFields(
        textFromContent(message.content),
        this.toolExecution.get(message.toolCallId)?.status === 'blocked'
          ? 'blocked'
          : message.isError
            ? 'error'
            : 'success',
        this.toolExecution.get(message.toolCallId)?.durationMs
      )
    )
  }

  private projectUserMessage(message: UserMessage, messageIndex: number): ConversationNode[] {
    const text = textFromContent(message.content)
    return text ? [{ id: `user-${message.timestamp}-${messageIndex}`, type: 'user', text }] : []
  }

  private projectAssistantMessage(
    message: AssistantMessage,
    streaming: boolean,
    results: ReadonlyMap<string, ToolResultMessage> = new Map()
  ): ConversationNode[] {
    const nodes = message.content.flatMap<ConversationNode>((block, blockIndex) => {
      if (block.type === 'text' && block.text) {
        return [
          {
            id: `assistant-${message.timestamp}-${blockIndex}`,
            type: 'assistant',
            markdown: block.text,
            streaming
          }
        ]
      }
      if (block.type === 'thinking' && block.thinking) {
        return [
          {
            id: `think-${message.timestamp}-${blockIndex}`,
            type: 'think',
            text: block.thinking,
            streaming
          }
        ]
      }
      if (block.type !== 'toolCall') return []

      const result = results.get(block.id)
      const rawOutput = result ? textFromContent(result.content) : undefined
      const presentation = toolPresentation(block.name, block.arguments)
      const trackedState = this.toolExecution.get(block.id)
      const trackedStatus = trackedState?.status
      const status =
        trackedStatus === 'blocked'
          ? 'blocked'
          : result
            ? result.isError
              ? 'error'
              : 'success'
            : (trackedStatus ?? 'queued')
      return [
        {
          id: `tool-${block.id}`,
          type: 'tool',
          toolCallId: block.id,
          name: block.name,
          intent: toolIntent(block.name),
          title: presentation.title,
          detail: presentation.detail,
          ...(rawOutput !== undefined ? this.toolOutputFields(rawOutput, status) : { status }),
          ...(trackedState?.durationMs !== undefined ? { durationMs: trackedState.durationMs } : {})
        }
      ]
    })
    if (message.errorMessage) {
      nodes.push({
        id: `error-${message.timestamp}`,
        type: 'error',
        message: message.errorMessage
      })
    }
    return nodes
  }

  private toolOutputFields(
    output: string,
    status: ToolStatus,
    durationMs?: number
  ): Pick<
    Extract<ConversationNode, { type: 'tool' }>,
    'output' | 'originalOutputLength' | 'truncated' | 'status' | 'durationMs'
  > {
    return {
      output: output.slice(0, MAX_TOOL_OUTPUT),
      originalOutputLength: output.length,
      truncated: output.length > MAX_TOOL_OUTPUT,
      status,
      ...(durationMs !== undefined ? { durationMs } : {})
    }
  }

  private updateToolNode(
    toolCallId: string,
    changes: Partial<Extract<ConversationNode, { type: 'tool' }>>
  ): void {
    this.conversationProjection.update(`tool-${toolCallId}`, (node) => {
      return node.type === 'tool' ? { ...node, ...changes } : node
    })
  }

  private metrics(session?: AgentSession): UsageMetrics {
    if (!session) {
      return { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    const stats = session.getSessionStats()
    const timing = this.timing ?? this.lastTiming
    const firstTokenMs = timing?.firstTokenSamples.length
      ? timing.firstTokenSamples.reduce((sum, value) => sum + value, 0) /
        timing.firstTokenSamples.length
      : undefined
    const tokensPerSecond = timing?.llmDurationMs
      ? timing.outputTokens / (timing.llmDurationMs / 1000)
      : undefined
    return {
      turns: stats.userMessages,
      steps: stats.toolCalls,
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      ...(stats.contextUsage?.tokens !== null ? { contextTokens: stats.contextUsage?.tokens } : {}),
      ...(stats.contextUsage
        ? {
            contextWindow: stats.contextUsage.contextWindow,
            ...(stats.contextUsage.percent !== null
              ? { contextPercent: stats.contextUsage.percent }
              : {})
          }
        : {}),
      ...(timing?.llmDurationMs ? { llmDurationMs: timing.llmDurationMs } : {}),
      ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {})
    }
  }

  private sessionStatus(session?: AgentSession): SessionStatus {
    if (this.lastError) return 'error'
    if (this.approvalRegistry.requests(this.sessionGeneration).length > 0) {
      return 'awaiting-approval'
    }
    return session?.isStreaming ? 'running' : 'idle'
  }

  private sessionModelMutationTarget(): SessionModelMutationTarget | null {
    const session = this.runtime?.session
    if (!session) return null
    const sessionId = session.sessionManager.getSessionId()
    return {
      sessionId,
      generation: this.sessionGeneration,
      busy: session.isStreaming,
      promptPending: (this.pendingPromptsBySession.get(sessionId) ?? 0) > 0,
      hasTranscript: hasPersistentTranscript(session.sessionManager.buildContextEntries())
    }
  }

  private projectActiveSessionModel(
    session: AgentSession,
    explicitModel: ExactModelSelection | null = this.activeExplicitModel
  ): SessionModelProjection {
    const manager = session.sessionManager
    return projectSessionModelPin(
      {
        header: manager.getHeader(),
        entries: manager.buildContextEntries(),
        contextModel: manager.buildSessionContext().model,
        runtimeModel: isConcreteModel(session.model) ? session.model : null,
        explicitModel
      },
      this.accounts,
      this.models
    )
  }

  private snapshot(revision = this.revision): AgentSnapshot {
    const session = this.runtime?.session
    const modelProjection = session ? this.projectActiveSessionModel(session) : null
    const status = this.sessionStatus(session)
    const sessionFile = session?.sessionFile
    const activeSessionPath = sessionFile && existsSync(sessionFile) ? sessionFile : null
    const approvals = this.approvalRegistry.requests(this.sessionGeneration)
    return {
      sessionId: session?.sessionManager.getSessionId() ?? null,
      generation: this.sessionGeneration,
      revision,
      ready: this.initialized,
      engine: AGENT_ENGINE,
      agentDir: AGENT_DIR,
      project: this.projectPath
        ? { path: this.projectPath, name: basename(this.projectPath) }
        : null,
      sessions: this.sessions.map((summary) => ({
        ...summary,
        status: projectedSessionStatus(summary.path, activeSessionPath, status)
      })),
      activeSessionPath,
      nodes: this.conversationProjection.view(),
      accounts: this.accounts,
      models: this.models,
      activeProvider: modelProjection?.identity?.providerId ?? null,
      activeModel: modelProjection?.identity?.modelId ?? null,
      modelAvailability: modelProjection?.modelAvailability ?? 'unselected',
      composeBlockReason: this.projectPath
        ? (modelProjection?.composeBlockReason ?? 'model-required')
        : 'project-required',
      busy: session?.isStreaming ?? false,
      status,
      approvals,
      followUp: [...this.followUp],
      queuedCount: this.followUp.length,
      permissionMode: this.permissionMode,
      metrics: this.metrics(session),
      login: this.login,
      loginPrompt: this.loginPrompt,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  private clearPatchTimer(): void {
    this.patchBatcher.dispose()
  }

  private resetPublishedState(): void {
    this.clearPatchTimer()
    this.pendingStreamingMessage = null
    this.revision = 0
    this.publishedSnapshot = null
    this.conversationProjection.reset([])
  }

  private emitSnapshot(): AgentSnapshot {
    this.clearPatchTimer()
    this.pendingStreamingMessage = null
    const session = this.runtime?.session
    this.conversationProjection.reset(session ? this.projectMessages(session) : [])
    const streaming = session?.agent.state.streamingMessage
    if (isPiMessage(streaming) && streaming.role === 'assistant') {
      this.conversationProjection.trackGroup(
        `assistant-message-${streaming.timestamp}`,
        this.projectAssistantMessage(streaming, true).map((node) => node.id)
      )
    }
    const snapshot = this.snapshot()
    this.publishedSnapshot = snapshot
    send({ type: 'event', event: 'snapshot', data: snapshot })
    return snapshot
  }

  private emitPatch(): AgentSnapshot {
    this.clearPatchTimer()
    this.projectPendingStreamingMessage()
    if (this.patchesSuspended) return this.snapshot()
    const previous = this.publishedSnapshot
    if (
      !previous ||
      previous.sessionId !== (this.runtime?.session.sessionManager.getSessionId() ?? null) ||
      previous.generation !== this.sessionGeneration
    ) {
      return this.emitSnapshot()
    }

    const next = this.snapshot(this.revision + 1)
    const patch: AgentStatePatch = createStatePatch(
      previous,
      next,
      this.conversationProjection.drainChanges()
    )
    this.revision = next.revision
    this.publishedSnapshot = next
    send({ type: 'event', event: 'patch', data: patch })
    return next
  }

  private emitStreamingPatch(): AgentSnapshot {
    this.clearPatchTimer()
    this.projectPendingStreamingMessage()
    if (this.patchesSuspended) return this.publishedSnapshot ?? this.snapshot()

    const result = buildStreamingPatch({
      previous: this.publishedSnapshot,
      sessionId: this.runtime?.session.sessionManager.getSessionId() ?? null,
      generation: this.sessionGeneration,
      nodes: this.conversationProjection.view(),
      changes: this.conversationProjection.drainChanges(),
      buildDurableSnapshot: () => this.emitSnapshot()
    })
    if (result.kind === 'snapshot') return result.snapshot

    this.revision = result.snapshot.revision
    this.publishedSnapshot = result.snapshot
    send({ type: 'event', event: 'patch', data: result.patch })
    return result.snapshot
  }

  private schedulePatch(): void {
    this.patchBatcher.schedule()
  }

  private projectPendingStreamingMessage(): void {
    const pending = this.pendingStreamingMessage
    if (!pending) return
    this.pendingStreamingMessage = null
    this.projectEventMessage(pending, true)
  }

  private flushPatch(): void {
    this.patchBatcher.dispose()
    this.emitPatch()
  }

  private async disposeRuntime(): Promise<void> {
    const runtime = this.runtime
    this.abandonRuntime()
    if (runtime) await runtime.dispose()
  }

  private abandonRuntime(): void {
    this.rejectApprovals(true, 'session-switch')
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.sessionGeneration += 1
    this.resetPublishedState()
    this.runtime = null
    this.activeExplicitModel = null
    this.pendingNewSessionModel = null
    this.pendingNewSessionRuntimeModel = null
    this.pendingPromptsBySession.clear()
    this.sessions = []
    this.followUp = []
    this.toolExecution.clear()
  }
}

const host = new PiDesktopHost()

process.parentPort.on('message', (event) => {
  const parsed = hostRequestSchema.safeParse(event.data)
  if (!parsed.success) {
    const requestId =
      isRecord(event.data) && typeof event.data.requestId === 'string'
        ? event.data.requestId
        : 'invalid'
    send({
      type: 'response',
      requestId,
      ok: false,
      error: 'Agent Host 收到无效请求'
    })
    return
  }

  const request = parsed.data
  void host
    .handle(request)
    .then((result) => {
      if (!hostResultMatchesCommand(request, result)) {
        throw new Error(`Agent Host 响应类型不匹配：${request.type}`)
      }
      send({ type: 'response', requestId: request.requestId, ok: true, data: result })
    })
    .catch((error) => {
      send({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: errorMessage(error)
      })
    })
})

void host.initialize().catch((error) => {
  console.error(`Agent Host 初始化失败：${errorMessage(error)}`)
})
