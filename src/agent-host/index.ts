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
  CredentialInfo,
  Message,
  Model,
  Provider,
  ToolResultMessage
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
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import {
  AGENT_ENGINE,
  type AccountSummary,
  type AgentSnapshot,
  type ApprovalRequest,
  type ConversationNode,
  type HostMessage,
  type HostRequest,
  type LoginMethod,
  type LoginPrompt,
  type LoginStatus,
  type ModelSummary,
  type PermissionMode,
  type SessionSummary,
  type ToolIntent,
  type ToolStatus,
  type UsageMetrics
} from '../shared/contracts'
import { hostRequestSchema } from '../shared/schemas'

const AGENT_DIR = join(homedir(), '.pi', 'agent')
const MULTI_LOGIN_CONFIG = join(AGENT_DIR, 'pi-multi-login.json')
const ALIAS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_TOOL_OUTPUT = 12_000

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

type PendingApproval = {
  resolve: (allow: boolean) => void
  timer: NodeJS.Timeout
  toolCallId: string
}

type PendingLoginPrompt = {
  resolve: (value: string) => void
  signal?: AbortSignal
}

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
  private preferredProvider: string | null = null
  private preferredModel: string | null = null
  private accounts: AccountSummary[] = []
  private models: ModelSummary[] = []
  private sessions: SessionSummary[] = []
  private login: LoginStatus = { phase: 'idle' }
  private lastError: string | undefined
  private initialized = false
  private initializing: Promise<void> | null = null
  private unsubscribeSession: (() => void) | undefined
  private sessionGeneration = 0
  private toolStatuses = new Map<string, ToolStatus>()
  private pendingApprovals = new Map<string, PendingApproval>()
  private pendingLoginPrompts = new Map<string, PendingLoginPrompt>()
  private loginAbort: AbortController | null = null
  private approvalMetadata: ApprovalRequest | null = null
  private timing: RunTiming | null = null
  private lastTiming: RunTiming | null = null

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
      this.emitState()
    })()
    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  async handle(request: HostRequest): Promise<AgentSnapshot> {
    await this.initialize()
    this.lastError = undefined

    switch (request.type) {
      case 'bootstrap':
      case 'state:get':
        break
      case 'project:open':
        await this.openProject(request.cwd)
        break
      case 'session:new':
        await this.newSession(request.providerId, request.modelId)
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
      case 'permission:set':
        this.permissionMode = request.mode
        break
      case 'permission:respond':
        this.resolveApproval(request.requestId, request.allow)
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

    const snapshot = this.snapshot()
    this.emitState(snapshot)
    return snapshot
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
            id: '',
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
        this.emitState()
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

  private async createRuntime(sessionManager: SessionManager): Promise<AgentSessionRuntime> {
    if (!this.sdk || !this.modelRuntime || !this.projectPath) {
      throw new Error('Agent Host 尚未选择工作区')
    }
    const sdk = this.sdk
    const fixedModelRuntime = this.modelRuntime
    const extensionPath = multiLoginExtensionPath()
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
      const preferred = this.preferredModel
        ? fixedModelRuntime.getAvailableSnapshot().find((model) => {
            return model.provider === this.preferredProvider && model.id === this.preferredModel
          })
        : undefined
      const isNew = nextManager.getEntries().length === 0
      const result = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: nextManager,
        sessionStartEvent,
        model: isNew ? preferred : undefined,
        tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
      })
      return { ...result, services, diagnostics: services.diagnostics }
    }

    return sdk.createAgentSessionRuntime(createRuntime, {
      cwd: this.projectPath,
      agentDir: AGENT_DIR,
      sessionManager
    })
  }

  private async openProject(cwd: string): Promise<void> {
    const stats = statSync(cwd)
    if (!stats.isDirectory()) throw new Error('所选工作区不是文件夹')

    await this.disposeRuntime()
    this.projectPath = cwd
    if (!this.sdk) throw new Error('Pi SDK 尚未加载')
    const sessionManager = this.sdk.SessionManager.continueRecent(cwd)
    this.runtime = await this.createRuntime(sessionManager)
    this.runtime.setRebindSession(async () => this.bindSession())
    await this.bindSession()
    await this.refreshAuthProjection()
    await this.refreshSessions()
  }

  private async bindSession(): Promise<void> {
    const session = this.runtime?.session
    if (!session) return
    this.sessionGeneration += 1
    const generation = this.sessionGeneration
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.rejectApprovals()
    this.toolStatuses.clear()
    this.lastTiming = null
    this.timing = null

    await session.bindExtensions({
      uiContext: this.createUiContext(),
      mode: 'rpc',
      abortHandler: () => void session.abort(),
      onError: (error) => {
        this.lastError = `${error.extensionPath}: ${error.error}`
        this.emitState()
      }
    })

    this.unsubscribeSession = session.subscribe((event) => {
      if (generation !== this.sessionGeneration) return
      this.handleSessionEvent(event)
    })
    if (isConcreteModel(session.model)) {
      this.preferredProvider = session.model?.provider ?? this.preferredProvider
      this.preferredModel = session.model?.id ?? this.preferredModel
    }
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
        if (isRecord(event.message) && event.message.role === 'assistant' && this.timing) {
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
        break
      }
      case 'message_end':
        if (isRecord(event.message) && event.message.role === 'assistant' && this.timing) {
          if (this.timing.llmStartedAt) this.timing.llmDurationMs += now - this.timing.llmStartedAt
          const usage = isRecord(event.message.usage) ? event.message.usage : undefined
          if (typeof usage?.output === 'number') this.timing.outputTokens += usage.output
          this.timing.llmStartedAt = undefined
        }
        break
      case 'tool_execution_start':
        this.toolStatuses.set(event.toolCallId, 'running')
        break
      case 'tool_execution_end':
        this.toolStatuses.set(event.toolCallId, event.isError ? 'error' : 'success')
        break
      case 'agent_settled':
        if (this.timing) this.lastTiming = { ...this.timing }
        this.timing = null
        void this.refreshSessions()
        break
      case 'queue_update':
        break
    }
    this.emitState()
  }

  private async refreshSessions(): Promise<void> {
    if (!this.projectPath) {
      this.sessions = []
      return
    }
    const current = this.runtime?.session.sessionFile
    if (!this.sdk) return
    const listed = await this.sdk.SessionManager.list(this.projectPath)
    this.sessions = listed.map((session) => ({
      id: session.id,
      path: session.path,
      title: session.name || session.firstMessage || '新会话',
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
      active: session.path === current
    }))
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
    if (providerId && modelId) {
      this.preferredProvider = providerId
      this.preferredModel = modelId
    } else {
      const current = this.runtime.session.model
      if (isConcreteModel(current)) {
        this.preferredProvider = current?.provider ?? this.preferredProvider
        this.preferredModel = current?.id ?? this.preferredModel
      }
    }
    const result = await this.runtime.newSession()
    if (result.cancelled) return
    const manager = this.runtime.session.sessionManager
    const path = manager.getSessionFile()
    if (path && !existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        // Pi only flushes a normal new session after its first assistant message. Desktop needs
        // an explicit /new to be listable immediately, so let SessionManager initialize the
        // empty target with its own canonical header and mark the manager flushed.
        manager.setSessionFile(path)
      } catch (error) {
        rmSync(path, { force: true })
        throw error
      }
      manager.appendSessionInfo('新会话')
      const activeModel = this.runtime.session.model
      if (activeModel && isConcreteModel(activeModel)) {
        manager.appendModelChange(activeModel.provider, activeModel.id)
      }
    }
    await this.refreshSessions()
  }

  private async openSession(path: string): Promise<void> {
    if (!this.runtime || !this.projectPath) throw new Error('请先选择工作区')
    if (!this.sdk) throw new Error('Pi SDK 尚未加载')
    const sessions = await this.sdk.SessionManager.list(this.projectPath)
    if (!sessions.some((session) => session.path === path)) throw new Error('会话不属于当前工作区')
    const result = await this.runtime.switchSession(path)
    if (result.cancelled) return
    await this.refreshSessions()
  }

  private sendPrompt(rawText: string): void {
    const session = this.runtime?.session
    if (!session) throw new Error('请先选择工作区')
    const text = rawText.trim()
    if (!text) throw new Error('请输入任务内容')
    if (!isConcreteModel(session.model)) throw new Error('请先登录并选择模型')

    const behavior = session.isStreaming ? 'followUp' : undefined
    void session
      .prompt(text, {
        ...(behavior ? { streamingBehavior: behavior } : {}),
        source: 'rpc'
      })
      .catch((error) => {
        this.lastError = errorMessage(error)
        this.emitState()
      })
  }

  private async abortPrompt(): Promise<void> {
    this.rejectApprovals()
    await this.runtime?.session.abort()
  }

  private async setModel(providerId: string, modelId: string): Promise<void> {
    if (!this.modelRuntime) throw new Error('模型运行时尚未就绪')
    if (this.runtime?.session.messages.some((message) => message.role === 'user')) {
      throw new Error('当前会话已钉住账号与模型；切换会自动新建会话')
    }
    const model = this.modelRuntime
      .getAvailableSnapshot()
      .find((item) => item.provider === providerId && item.id === modelId)
    if (!model) throw new Error('所选模型不可用或账号未登录')

    this.preferredProvider = providerId
    this.preferredModel = modelId
    if (this.runtime?.session) await this.runtime.session.setModel(model)
  }

  private requestApproval(message: string, signal?: AbortSignal): Promise<boolean> {
    const metadata = this.approvalMetadata
    if (!metadata) return Promise.resolve(false)
    if (signal?.aborted) return Promise.resolve(false)

    const id = randomUUID()
    const request: ApprovalRequest = { ...metadata, id, detail: message || metadata.detail }
    this.toolStatuses.set(request.toolCallId, 'awaiting-approval')
    send({ type: 'event', event: 'approval', data: request })
    this.emitState()

    return new Promise((resolve) => {
      const finish = (allow: boolean): void => {
        const pending = this.pendingApprovals.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingApprovals.delete(id)
        this.toolStatuses.set(request.toolCallId, allow ? 'queued' : 'blocked')
        signal?.removeEventListener('abort', onAbort)
        resolve(allow)
        this.emitState()
      }
      const onAbort = (): void => finish(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => finish(false), 5 * 60_000)
      this.pendingApprovals.set(id, { resolve: finish, timer, toolCallId: request.toolCallId })
    })
  }

  private resolveApproval(id: string, allow: boolean): void {
    this.pendingApprovals.get(id)?.resolve(allow)
  }

  private rejectApprovals(): void {
    for (const approval of [...this.pendingApprovals.values()]) approval.resolve(false)
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
    this.emitState()

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
        this.emitState()
      }
    }

    void this.modelRuntime
      .login(providerId, 'oauth', interaction)
      .then(async () => {
        await this.refreshAuthProjection()
        const session = this.runtime?.session
        if (session && !isConcreteModel(session.model)) {
          const first = this.modelRuntime
            ?.getAvailableSnapshot()
            .find((model) => model.provider === providerId)
          if (first) await session.setModel(first)
        }
        this.login = { phase: 'success', providerId }
        this.emitState()
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        this.login = { phase: 'error', providerId, message: errorMessage(error) }
        this.emitState()
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
    send({ type: 'event', event: 'login-prompt', data })

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.pendingLoginPrompts.delete(id)
        resolve('')
      }
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingLoginPrompts.set(id, {
        resolve: (value) => {
          prompt.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        signal: prompt.signal
      })
    })
  }

  private resolveLoginPrompt(id: string, value?: string): void {
    const prompt = this.pendingLoginPrompts.get(id)
    if (!prompt) return
    this.pendingLoginPrompts.delete(id)
    prompt.resolve(value ?? '')
  }

  private rejectLoginPrompts(): void {
    for (const [id, prompt] of [...this.pendingLoginPrompts]) {
      this.pendingLoginPrompts.delete(id)
      prompt.resolve('')
    }
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

    const nodes: ConversationNode[] = []
    messages.forEach((message, messageIndex) => {
      if (message.role === 'user') {
        const text = textFromContent(message.content)
        if (text)
          nodes.push({ id: `user-${message.timestamp}-${messageIndex}`, type: 'user', text })
        return
      }
      if (message.role !== 'assistant') return

      message.content.forEach((block, blockIndex) => {
        if (block.type === 'text' && block.text) {
          nodes.push({
            id: `assistant-${message.timestamp}-${blockIndex}`,
            type: 'assistant',
            markdown: block.text,
            streaming: message === streaming
          })
        } else if (block.type === 'thinking' && block.thinking) {
          nodes.push({
            id: `think-${message.timestamp}-${blockIndex}`,
            type: 'think',
            text: block.thinking,
            streaming: message === streaming
          })
        } else if (block.type === 'toolCall') {
          const result = results.get(block.id)
          const presentation = toolPresentation(block.name, block.arguments)
          const status = result
            ? result.isError
              ? 'error'
              : 'success'
            : (this.toolStatuses.get(block.id) ?? 'queued')
          nodes.push({
            id: `tool-${block.id}`,
            type: 'tool',
            toolCallId: block.id,
            name: block.name,
            intent: toolIntent(block.name),
            title: presentation.title,
            detail: presentation.detail,
            output: result ? textFromContent(result.content).slice(0, MAX_TOOL_OUTPUT) : undefined,
            status
          })
        }
      })
      if (message.errorMessage) {
        nodes.push({
          id: `error-${message.timestamp}`,
          type: 'error',
          message: message.errorMessage
        })
      }
    })
    return nodes
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

  private snapshot(): AgentSnapshot {
    const session = this.runtime?.session
    const sessionModel = isConcreteModel(session?.model) ? session?.model : undefined
    return {
      ready: this.initialized,
      engine: AGENT_ENGINE,
      agentDir: AGENT_DIR,
      project: this.projectPath
        ? { path: this.projectPath, name: basename(this.projectPath) }
        : null,
      sessions: this.sessions,
      activeSessionPath: session?.sessionFile ?? null,
      nodes: session ? this.projectMessages(session) : [],
      accounts: this.accounts,
      models: this.models,
      activeProvider: sessionModel?.provider ?? this.preferredProvider,
      activeModel: sessionModel?.id ?? this.preferredModel,
      busy: session?.isStreaming ?? false,
      queuedCount: session?.pendingMessageCount ?? 0,
      permissionMode: this.permissionMode,
      metrics: this.metrics(session),
      login: this.login,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  private emitState(snapshot = this.snapshot()): void {
    send({ type: 'event', event: 'state', data: snapshot })
  }

  private async disposeRuntime(): Promise<void> {
    this.sessionGeneration += 1
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.rejectApprovals()
    if (this.runtime) await this.runtime.dispose()
    this.runtime = null
    this.sessions = []
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
    .then((snapshot) => {
      send({ type: 'response', requestId: request.requestId, ok: true, data: snapshot })
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
