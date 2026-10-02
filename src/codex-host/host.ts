import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type {
  AccountSummary,
  AgentSnapshot,
  HostCommand,
  HostEvent,
  HostResult,
  ModelSummary,
  PermissionMode,
  SessionSummary,
  ThinkingLevel
} from '../shared/contracts'
import { CODEX_RUNTIME_MANIFEST } from '../shared/codex-runtime'
import { MAX_SKILL_BYTES, MAX_SKILLS, safeSkillName, type SkillSummary } from '../shared/skills'
import {
  credentialResponseSchema,
  type ChatgptAccessToken,
  type CredentialRequest,
  type SharedChatgptAccount
} from '../shared/engine-credentials'
import { createEmptyAgentSnapshot } from '../shared/initial-agent-snapshot'
import {
  comparePinned,
  projectDisplayName,
  projectIsHidden,
  sessionIsArchived
} from '../shared/navigation-library'
import type { ProjectCatalog, ProjectCatalogCommand } from '../shared/project-catalog'
import { diffState } from '../shared/state-patch'
import { ApprovalRegistry } from '../agent-host/approval-registry'
import { SerialExecutor } from '../agent-host/serial-executor'
import { AppServerClient, type AppServerNotification, type AppServerRequest } from './app-server'
import { CodexMcp } from './mcp'
import { CodexProjection, displayCommand, type CodexItem } from './projection'
import { CodexSessionStore, type CodexSessionReference, type CodexStorage } from './storage'
import { t } from '../shared/i18n'

export type CodexHostOptions = {
  storage: CodexStorage
  role: 'configuration' | 'session'
  executable?: string
  /** `-c key=value` overrides, used by tests to point Codex at a local model server. */
  config?: string[]
  version?: string
  /** Pause before restarting a crashed app-server. */
  restartDelayMs?: number
  post(message: unknown): void
}

type CodexModel = {
  id: string
  displayName: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: { reasoningEffort: string }[]
  defaultReasoningEffort: string
  inputModalities?: string[]
}

type Preferences = { model?: string; effort?: string; account?: string }

/** Codex reads a custom model provider from its own config; no ChatGPT account is involved. */
export const CONFIGURED_CONNECTION = 'codex-config'

const POLICY: Record<PermissionMode, { approvalPolicy: string; sandbox: string }> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  open: { approvalPolicy: 'never', sandbox: 'danger-full-access' }
}
const EFFORTS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

/** A stable UUID-shaped id for something identified by a path. */
function uuidFrom(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class CodexHost {
  private readonly commands = new SerialExecutor()
  private snapshot: AgentSnapshot
  private published: AgentSnapshot
  private readonly projection = new CodexProjection()
  readonly store: CodexSessionStore
  private readonly approvals: ApprovalRegistry
  private server: AppServerClient | undefined
  private starting: Promise<void> | undefined
  private reference: CodexSessionReference | undefined
  private models: CodexModel[] = []
  private shared: SharedChatgptAccount[] = []
  private configured = false
  private signedInAs: string | undefined
  private crashes: number[] = []
  private missingAccount: string | undefined
  private readonly mcp = new CodexMcp(
    () => this.server_(),
    () => this.reference?.threadId,
    (url) => this.options.post({ type: 'event', event: 'open-external', data: { url, mcp: true } })
  )
  private turn: { threadId: string; turnId: string } | undefined
  private running = false
  private disposed = false
  private prefs: Preferences = {}
  private readonly credentialRequests = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private titles = new Map<string, { title: string; updated: number }>()

  constructor(private readonly options: CodexHostOptions) {
    this.store = new CodexSessionStore(options.storage)
    this.snapshot = createEmptyAgentSnapshot(CODEX_RUNTIME_MANIFEST.engine, options.storage.config)
    this.snapshot.runtime = CODEX_RUNTIME_MANIFEST
    this.published = structuredClone(this.snapshot)
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
      this.publish()
    })
  }

  getState(): AgentSnapshot {
    return structuredClone(this.snapshot)
  }

  /** Desktop replies to this host's credential requests. */
  accept(message: unknown): boolean {
    const parsed = credentialResponseSchema.safeParse(message)
    if (!parsed.success) return false
    const pending = this.credentialRequests.get(parsed.data.requestId)
    if (!pending) return true
    this.credentialRequests.delete(parsed.data.requestId)
    if (parsed.data.ok) pending.resolve(parsed.data.data)
    else pending.reject(new Error(parsed.data.error))
    return true
  }

  private credential<T>(
    request: Omit<Extract<CredentialRequest, { kind: 'chatgpt-accounts' }>, 'type' | 'requestId'>
  ): Promise<T>
  private credential<T>(
    request: Omit<Extract<CredentialRequest, { kind: 'chatgpt-token' }>, 'type' | 'requestId'>
  ): Promise<T>
  private credential<T>(request: Record<string, unknown>): Promise<T> {
    const requestId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      // The user may be deciding in a dialog; give them time.
      const timer = setTimeout(() => {
        this.credentialRequests.delete(requestId)
        reject(new Error(t('桌面端没有回应账号请求')))
      }, 150_000)
      this.credentialRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.options.post({ type: 'credential:request', requestId, ...request })
    })
  }

  handle(
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    const execute = (): Promise<HostResult> => this.execute(command, expectedIdentity)
    return ['permission:respond', 'prompt:abort', 'runtime:shutdown'].includes(command.type)
      ? execute()
      : this.commands.run(execute)
  }

  private async execute(
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    if (this.disposed && command.type !== 'runtime:shutdown')
      throw new Error('Codex runtime is disposed')
    if (expectedIdentity) this.assertIdentity(expectedIdentity)
    if ('sessionId' in command && 'generation' in command) this.assertIdentity(command)
    switch (command.type) {
      case 'bootstrap':
        await this.start()
        this.publish(true)
        return this.result()
      case 'state:get':
        if (command.refreshSessions) {
          await this.refreshSessions()
          this.publish()
        }
        return this.result()
      case 'runtime:refresh':
        this.assertIdle()
        await this.refreshAccounts()
        this.publish()
        return this.result()
      case 'runtime:shutdown':
        this.disposed = true
        this.approvals.clear(this.snapshot.generation, 'abort')
        this.server?.dispose()
        await this.server?.exited()
        this.snapshot.ready = false
        return this.result()
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
      case 'session:new': {
        if (!this.snapshot.project) throw new Error('Open a project first')
        if ('modelId' in command) {
          this.validateModel(command.providerId, command.modelId)
          this.prefs.model = command.modelId
          this.prefs.account = command.providerId
        }
        return this.transition(this.snapshot.project.path)
      }
      case 'session:fork': {
        this.assertIdle()
        const source = this.reference
        if (!source?.threadId || !this.snapshot.activeSessionPath)
          throw new Error('No Codex session')
        // Entries are Codex turn ids: the fork keeps every turn up to and including this one.
        const turnIds = new Set(
          this.projection.nodes.flatMap((node) =>
            (node.type === 'user' || node.type === 'assistant') && node.canonicalEntryId
              ? [node.canonicalEntryId]
              : []
          )
        )
        if (!turnIds.has(command.entryId)) throw new Error('Fork target is not a Codex turn')
        const forked = await this.server_().request<{ thread: { id: string } }>('thread/fork', {
          threadId: source.threadId,
          lastTurnId: command.entryId,
          cwd: source.cwd,
          ...POLICY[this.snapshot.permissionMode]
        })
        const reference: CodexSessionReference = {
          ...this.store.create(source.cwd, source.account),
          threadId: forked.thread.id,
          parentSessionPath: this.snapshot.activeSessionPath
        }
        await this.transition(source.cwd, reference)
        return { kind: 'session-fork', cancelled: false, snapshot: this.getState() }
      }
      case 'skills:list': {
        const skills = await this.skills()
        return {
          kind: 'skills-list',
          catalog: {
            sessionId: command.sessionId,
            generation: command.generation,
            skills: skills.slice(0, MAX_SKILLS).map((skill) => skill.summary),
            total: skills.length,
            truncated: skills.length > MAX_SKILLS
          }
        }
      }
      case 'skills:detail': {
        const skill = (await this.skills()).find((item) => item.summary.id === command.id)
        if (!skill) throw new Error(t('这个技能已不存在'))
        const preview = await readFile(skill.path, 'utf8').catch(() => '')
        return {
          kind: 'skills-detail',
          detail: {
            sessionId: command.sessionId,
            generation: command.generation,
            skill: skill.summary,
            preview: preview.slice(0, MAX_SKILL_BYTES)
          }
        }
      }
      case 'session:rename': {
        this.assertIdle()
        if (!this.reference) throw new Error('No Codex session')
        this.reference.title = command.name.slice(0, 200)
        await this.store.save(this.reference)
        if (this.reference.threadId)
          await this.server
            ?.request('thread/name/set', { threadId: this.reference.threadId, name: command.name })
            .catch(() => undefined)
        await this.refreshSessions()
        this.publish()
        return this.ack()
      }
      case 'prompt:send':
        return this.send(command.text, command.images ?? [])
      case 'prompt:abort': {
        this.approvals.clear(this.snapshot.generation, 'abort')
        const turn = this.turn
        if (turn) await this.server?.request('turn/interrupt', turn).catch(() => undefined)
        this.running = false
        this.turn = undefined
        this.projection.settle()
        this.projection.stopped(randomUUID())
        this.snapshot.status = 'stopped'
        this.publish()
        return this.ack()
      }
      case 'permission:set':
        this.snapshot.permissionMode = command.mode
        this.publish()
        return this.ack()
      case 'permission:respond':
        if (!this.approvals.resolve(command.approvalId, this.snapshot.generation, command.allow))
          throw new Error('Approval has expired')
        return this.ack()
      case 'model:set':
        this.assertIdle()
        this.validateModel(command.providerId, command.modelId)
        this.snapshot.activeModel = command.modelId
        this.prefs.model = command.modelId
        if (command.providerId !== this.snapshot.activeProvider) {
          this.snapshot.activeProvider = command.providerId
          if (this.reference) {
            this.reference.account = command.providerId
            await this.store.save(this.reference)
          } else this.prefs.account = command.providerId
        }
        await this.savePrefs()
        this.updateModelState()
        this.publish()
        return this.ack()
      case 'thinking:set': {
        this.assertIdle()
        const available = this.snapshot.thinking?.available ?? []
        if (!available.includes(command.level))
          throw new Error('This Codex model does not support that effort level')
        this.prefs.effort = command.level
        await this.savePrefs()
        this.updateModelState()
        this.publish()
        return this.ack()
      }
      case 'account:login':
      case 'account:add':
        throw new Error(
          t('Codex 使用 Pi 里的 ChatGPT 账号：请在「设置 › 引擎与账号」添加 ChatGPT 账号')
        )
      case 'account:remove':
        throw new Error(t('ChatGPT 账号由 Pi 管理，请在「设置 › 引擎与账号」中移除'))
      case 'mcp:list':
      case 'mcp:shutdown':
      case 'mcp:reload':
      case 'mcp:save':
      case 'mcp:toggle':
      case 'mcp:login':
      case 'mcp:logout':
        if (command.type !== 'mcp:list') this.assertIdle()
        await this.start()
        return { kind: 'mcp', result: await this.mcp.handle(command) }
      case 'project:catalog':
        return { kind: 'project-catalog', catalog: await this.catalog(command) }
      default:
        throw new Error(t('Codex 暂不支持此操作：{type}', { type: command.type }))
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private async start(): Promise<void> {
    if (this.server) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (!this.options.executable)
        throw new Error(t('Codex 尚未下载：在「设置 › 引擎与账号」里下载后即可使用'))
      await mkdir(this.options.storage.config, { recursive: true })
      this.prefs = await this.readPrefs()
      const server = new AppServerClient({
        executable: this.options.executable,
        codexHome: this.options.storage.config,
        ...(this.options.config ? { config: this.options.config } : {}),
        onNotification: (message) => this.notification(message),
        onRequest: (message) => this.serverRequest(message),
        onExit: (error) => {
          if (this.server !== server) return
          this.server = undefined
          this.signedInAs = undefined
          this.running = false
          this.turn = undefined
          this.snapshot.status = 'idle'
          this.approvals.clear(this.snapshot.generation, 'abort')
          this.snapshot.ready = false
          this.snapshot.error = error?.message ?? t('Codex 已退出')
          this.projection.settle()
          if (this.snapshot.project)
            this.projection.error(`codex-exit-${Date.now()}`, this.snapshot.error)
          this.publish()
          this.scheduleRestart()
        }
      })
      this.server = server
      await server.initialize(this.options.version ?? '0.1.0')
      await this.refreshAccounts()
      this.snapshot.ready = true
      this.snapshot.error = undefined
    })()
      .catch((error: unknown) => {
        this.server?.dispose()
        this.server = undefined
        this.snapshot.ready = false
        this.snapshot.error = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.starting = undefined
      })
    return this.starting
  }

  /**
   * A crashed app-server is started again and the open thread resumed, so the chat carries on.
   * Repeated crashes stop the automatic restarts; the next prompt still tries once more.
   */
  private scheduleRestart(): void {
    if (this.disposed) return
    const now = Date.now()
    this.crashes = [...this.crashes.filter((time) => now - time < 60_000), now]
    if (this.crashes.length > 3) {
      this.snapshot.error = t('Codex 反复退出，已停止自动重启：{value}', {
        value: this.snapshot.error ?? ''
      })
      this.publish()
      return
    }
    const timer = setTimeout(() => {
      void this.commands.run(() => this.revive()).catch(() => undefined)
    }, this.options.restartDelayMs ?? 1000)
    timer.unref?.()
  }

  private async revive(): Promise<void> {
    if (this.server || this.disposed) return
    await this.start()
    if (this.reference?.threadId && this.snapshot.project)
      await this.server_().request('thread/resume', {
        threadId: this.reference.threadId,
        cwd: this.snapshot.project.path,
        ...POLICY[this.snapshot.permissionMode]
      })
    this.projection.notice(t('Codex 意外退出，已自动重启并接上当前对话'))
    this.publish()
  }

  private server_(): AppServerClient {
    if (!this.server) throw new Error(this.snapshot.error ?? t('Codex 未在运行'))
    return this.server
  }

  private async refreshAccounts(): Promise<void> {
    const server = this.server_()
    const [account, models, config] = await Promise.all([
      server.request<{ requiresOpenaiAuth: boolean }>('account/read', {}),
      server.request<{ data: CodexModel[] }>('model/list', {}),
      server
        .request<{ config: { model?: string | null } }>('config/read', {})
        .catch(() => ({ config: {} as { model?: string | null } }))
    ])
    this.configured = !account.requiresOpenaiAuth
    this.shared = await this.credential<SharedChatgptAccount[]>({ kind: 'chatgpt-accounts' }).catch(
      () => []
    )
    this.models = models.data.filter((model) => !model.hidden)
    const configuredModel = config.config.model
    if (this.configured && configuredModel && !this.models.some((m) => m.id === configuredModel))
      this.models.unshift({
        id: configuredModel,
        displayName: configuredModel,
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium'
      })
    const accounts: AccountSummary[] = this.shared.map((account) => ({
      id: account.id,
      name: account.email ?? 'ChatGPT',
      authType: 'oauth',
      connected: true,
      subscription: true,
      alias: account.id !== 'openai-codex',
      platform: 'chatgpt',
      ...(account.email ? { email: account.email } : {}),
      ...(account.plan ? { plan: account.plan } : {})
    }))
    if (this.configured)
      accounts.unshift({
        id: CONFIGURED_CONNECTION,
        name: t('Codex 配置的模型服务'),
        authType: 'api_key',
        connected: true,
        subscription: false,
        alias: false,
        endpoint: 'config.toml'
      })
    this.snapshot.accounts = accounts
    this.snapshot.models = accounts.flatMap((account) =>
      this.models.map((model): ModelSummary => ({
        provider: account.id,
        id: model.id,
        name: model.displayName,
        contextWindow: 0,
        reasoning: model.supportedReasoningEfforts.length > 0,
        input: model.inputModalities?.includes('image') ? ['text', 'image'] : ['text']
      }))
    )
    const preferred = this.reference?.account ?? this.prefs.account
    this.snapshot.activeProvider =
      accounts.find((account) => account.id === preferred)?.id ?? accounts[0]?.id ?? null
    this.snapshot.activeModel =
      (this.prefs.model && this.models.some((model) => model.id === this.prefs.model)
        ? this.prefs.model
        : undefined) ??
      this.models.find((model) => model.isDefault)?.id ??
      this.models[0]?.id ??
      null
    this.updateModelState()
  }

  private updateModelState(): void {
    const model = this.models.find((item) => item.id === this.snapshot.activeModel)
    this.snapshot.modelAvailability = !this.snapshot.activeModel
      ? 'unselected'
      : model
        ? 'available'
        : 'unavailable'
    const available = (model?.supportedReasoningEfforts ?? [])
      .map((item) => item.reasoningEffort as ThinkingLevel)
      .filter((level) => EFFORTS.includes(level))
    const level = (this.prefs.effort ?? model?.defaultReasoningEffort) as ThinkingLevel | undefined
    this.snapshot.thinking = available.length
      ? { level: level && available.includes(level) ? level : available[0]!, available }
      : null
  }

  private validateModel(providerId: string, modelId: string): void {
    if (
      !this.snapshot.models.some((model) => model.provider === providerId && model.id === modelId)
    )
      throw new Error('This Codex model is not available')
  }

  // ---------------------------------------------------------------- sessions

  private async transition(cwd: string, reference?: CodexSessionReference): Promise<HostResult> {
    this.assertIdle()
    const project = resolve(cwd)
    if (!(await stat(project)).isDirectory()) throw new Error('Project directory is unavailable')
    await this.start()
    this.approvals.clear(this.snapshot.generation, 'session-switch')
    this.projection.clear()
    this.snapshot.generation++
    this.snapshot.revision = 0
    this.reference =
      reference ??
      this.store.create(project, this.prefs.account ?? this.snapshot.activeProvider ?? undefined)
    if (this.reference.cwd !== project) throw new Error('Session belongs to a different project')
    this.snapshot.project = { path: project, name: basename(project) }
    this.snapshot.sessionId = this.reference.id
    this.snapshot.activeSessionPath = await this.store.save(this.reference)
    this.snapshot.status = 'idle'
    this.snapshot.error = undefined
    this.snapshot.approvals = []
    this.snapshot.metrics = { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    await this.refreshAccounts()
    const missing = this.reference.account
    if (
      this.reference.threadId &&
      missing &&
      missing !== this.snapshot.activeProvider &&
      !this.snapshot.accounts.some((account) => account.id === missing)
    )
      this.missingAccount = missing
    if (this.reference.threadId) {
      const server = this.server_()
      await server.request('thread/resume', {
        threadId: this.reference.threadId,
        cwd: project,
        ...POLICY[this.snapshot.permissionMode]
      })
      const read = await server.request<{
        thread: { turns?: { id: string; items: CodexItem[] }[] }
      }>('thread/read', { threadId: this.reference.threadId, includeTurns: true })
      for (const turn of read.thread.turns ?? [])
        for (const item of turn.items) this.projection.item(item, true, turn.id)
    }
    if (this.missingAccount) {
      const now = this.snapshot.accounts.find(
        (account) => account.id === this.snapshot.activeProvider
      )
      this.projection.notice(
        now
          ? t('这段对话原来使用的 ChatGPT 账号已从 Pi 中移除，接下来会改用 {value}', {
              value: now.email ?? now.name
            })
          : t('这段对话原来使用的 ChatGPT 账号已从 Pi 中移除，请在「设置 › 引擎与账号」添加账号')
      )
      this.missingAccount = undefined
    }
    await this.refreshSessions()
    this.publish(true)
    return this.result()
  }

  private async refreshSessions(): Promise<void> {
    if (!this.snapshot.project) {
      this.snapshot.sessions = []
      return
    }
    this.snapshot.sessions = await this.summaries(this.snapshot.project.path)
  }

  private async threadTitles(): Promise<void> {
    if (!this.server) return
    const list = await this.server
      .request<{ data: { id: string; name: string | null; preview: string; updatedAt: number }[] }>(
        'thread/list',
        { limit: 200 }
      )
      .catch(() => ({ data: [] }))
    this.titles = new Map(
      list.data.map((thread) => [
        thread.id,
        { title: thread.name || thread.preview || 'New session', updated: thread.updatedAt * 1000 }
      ])
    )
  }

  private async summaries(cwd: string): Promise<SessionSummary[]> {
    await this.threadTitles()
    const refs = (await this.store.refs()).filter(
      (ref) => ref.cwd === cwd && (ref.threadId || ref.id === this.snapshot.sessionId)
    )
    return refs
      .map((ref) => {
        const thread = ref.threadId ? this.titles.get(ref.threadId) : undefined
        return {
          id: ref.id,
          runtimeId: 'codex',
          path: this.store.path(ref.id),
          title: (ref.title ?? thread?.title ?? 'New session').slice(0, 200),
          modified: new Date(thread?.updated ?? Date.parse(ref.created)).toISOString(),
          messageCount: 0,
          active: ref.id === this.snapshot.sessionId,
          ...(ref.parentSessionPath ? { parentSessionPath: ref.parentSessionPath } : {}),
          status: (ref.id === this.snapshot.sessionId
            ? this.snapshot.status
            : 'idle') as SessionSummary['status']
        }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))
  }

  private async catalog(command: ProjectCatalogCommand): Promise<ProjectCatalog> {
    const refs = await this.store.refs()
    const paths = command.cwd
      ? [resolve(command.cwd)]
      : [
          ...new Set([
            ...refs.filter((ref) => ref.threadId).map((ref) => ref.cwd),
            ...(this.snapshot.project ? [this.snapshot.project.path] : [])
          ])
        ]
    const visible = paths
      .filter((path) => command.includeHidden || !projectIsHidden(command.navigation, path))
      .sort((a, b) =>
        comparePinned(command.navigation?.projects[a], command.navigation?.projects[b])
      )
    const projects = await Promise.all(
      visible.slice(0, 100).map(async (path) => {
        const available = await stat(path).then(
          (info) => info.isDirectory(),
          () => false
        )
        const sessions = (await this.summaries(path)).filter(
          (session) =>
            command.includeArchived || !sessionIsArchived(command.navigation, session.path)
        )
        const offset = command.offset ?? 0
        return {
          path,
          name: projectDisplayName(command.navigation, path, basename(path)),
          sessions: sessions.slice(offset, offset + 50),
          totalSessions: sessions.length,
          nextOffset: offset + 50 < sessions.length ? offset + 50 : null,
          ...(!available ? { error: 'directory-unavailable' as const } : {})
        }
      })
    )
    return { projects, totalProjects: visible.length, truncated: visible.length > 100 }
  }

  // ---------------------------------------------------------------- skills

  /** Codex's own skill discovery for the open project, with stable desktop ids. */
  private async skills(): Promise<{ summary: SkillSummary; path: string }[]> {
    const cwd = this.snapshot.project?.path
    if (!cwd) return []
    const result = await this.server_().request<{
      data: {
        skills: {
          name: string
          description: string
          shortDescription?: string
          path: string
          scope: string
          enabled: boolean
        }[]
      }[]
    }>('skills/list', { cwds: [cwd] })
    return result.data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        path: skill.path,
        summary: {
          id: uuidFrom(skill.path),
          name: skill.name.slice(0, 128),
          description: (skill.shortDescription ?? skill.description).slice(0, 1024),
          scope: skill.scope === 'repo' ? ('project' as const) : ('user' as const),
          origin: 'top-level' as const,
          mode: 'model-and-manual' as const,
          canInsert: safeSkillName(skill.name)
        }
      }))
  }

  // ---------------------------------------------------------------- turns

  private async signIn(account: string): Promise<void> {
    if (account === CONFIGURED_CONNECTION || this.signedInAs === account) return
    const token = await this.credential<ChatgptAccessToken>({
      kind: 'chatgpt-token',
      accountId: account,
      reason: 'start'
    })
    await this.server_().request('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      chatgptPlanType: token.planType
    })
    this.signedInAs = account
  }

  private async send(
    text: string,
    images: { mimeType: string; data: string }[]
  ): Promise<HostResult> {
    if (!this.snapshot.project || !this.reference) throw new Error('Open a project first')
    this.assertIdle()
    if (this.snapshot.composeBlockReason)
      throw new Error(`Codex cannot compose: ${this.snapshot.composeBlockReason}`)
    if (!this.server) await this.revive()
    const server = this.server_()
    const account = this.snapshot.activeProvider!
    try {
      await this.signIn(account)
    } catch (error) {
      const message = explain(error)
      this.snapshot.status = 'error'
      this.projection.error(randomUUID(), message)
      this.publish()
      throw new Error(message)
    }
    const policy = POLICY[this.snapshot.permissionMode]
    if (!this.reference.threadId) {
      const started = await server.request<{ thread: { id: string } }>('thread/start', {
        cwd: this.snapshot.project.path,
        model: this.snapshot.activeModel,
        ...policy
      })
      this.reference.threadId = started.thread.id
      this.reference.account = account
      await this.store.save(this.reference)
    }
    const input: Record<string, unknown>[] = [{ type: 'text', text, text_elements: [] }]
    // `/skill:name` from the composer becomes Codex's own skill input.
    const named = [...text.matchAll(/(?:^|\s)\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)].map(
      (match) => match[1]!
    )
    if (named.length) {
      const skills = await this.skills().catch(() => [])
      for (const name of new Set(named)) {
        const skill = skills.find((item) => item.summary.name === name)
        if (skill) input.push({ type: 'skill', name, path: skill.path })
      }
    }
    if (images.length) {
      const directory = join(this.options.storage.cache, 'images', this.reference.id)
      await mkdir(directory, { recursive: true })
      for (const image of images) {
        const path = join(directory, `${randomUUID()}.${image.mimeType.split('/')[1]}`)
        await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
        input.push({ type: 'localImage', path })
      }
    }
    const threadId = this.reference.threadId
    this.running = true
    this.snapshot.status = 'running'
    this.snapshot.error = undefined
    this.publish()
    try {
      const started = await server.request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input,
        model: this.snapshot.activeModel,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy:
          policy.sandbox === 'danger-full-access'
            ? { type: 'dangerFullAccess' }
            : {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false
              },
        ...(this.snapshot.thinking ? { effort: this.snapshot.thinking.level } : {})
      })
      this.turn = { threadId, turnId: started.turn.id }
    } catch (error) {
      this.running = false
      this.snapshot.status = 'error'
      this.projection.error(randomUUID(), explain(error))
      this.publish()
      throw error
    }
    return this.ack()
  }

  private notification({ method, params }: AppServerNotification): void {
    if (method === 'mcpServer/oauthLogin/completed') {
      this.mcp.loginCompleted(params as { name: string; success: boolean; error?: string })
      return
    }
    const threadId = params.threadId as string | undefined
    if (threadId && threadId !== this.reference?.threadId) return
    switch (method) {
      case 'item/started':
        this.projection.item(params.item as CodexItem, false, params.turnId as string | undefined)
        break
      case 'item/completed':
        this.projection.item(params.item as CodexItem, true, params.turnId as string | undefined)
        break
      case 'item/agentMessage/delta':
        this.projection.delta(params.itemId as string, 'assistant', params.delta as string)
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.projection.delta(params.itemId as string, 'think', params.delta as string)
        break
      case 'item/commandExecution/outputDelta':
        this.projection.output(params.itemId as string, params.delta as string)
        break
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as {
          total: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
          last: { inputTokens: number }
          modelContextWindow: number | null
        }
        this.snapshot.metrics = {
          ...this.snapshot.metrics,
          input: usage.total.inputTokens,
          output: usage.total.outputTokens,
          cacheRead: usage.total.cachedInputTokens,
          contextTokens: usage.last.inputTokens,
          ...(usage.modelContextWindow
            ? {
                contextWindow: usage.modelContextWindow,
                contextPercent: Math.round(
                  (usage.last.inputTokens / usage.modelContextWindow) * 100
                )
              }
            : {})
        }
        break
      }
      case 'turn/completed': {
        const turn = params.turn as { status: string; error: { message: string } | null }
        this.running = false
        this.turn = undefined
        this.projection.settle()
        this.snapshot.metrics = { ...this.snapshot.metrics, turns: this.snapshot.metrics.turns + 1 }
        if (turn.status === 'failed') {
          this.snapshot.status = 'error'
          this.projection.error(randomUUID(), explain(turn.error?.message ?? t('Codex 回合失败')))
        } else if (turn.status === 'interrupted') this.snapshot.status = 'stopped'
        else this.snapshot.status = 'idle'
        void this.refreshSessions().then(() => this.publish())
        break
      }
      case 'error': {
        if (params.willRetry) break
        const error = params.error as { message?: string } | undefined
        this.projection.error(randomUUID(), explain(error?.message ?? t('Codex 出错')))
        break
      }
      case 'thread/name/updated':
        void this.refreshSessions().then(() => this.publish())
        return
      default:
        return
    }
    this.publish()
  }

  private async serverRequest({ method, params }: AppServerRequest): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const itemId = params.itemId as string
        const command = displayCommand((params.command as string | undefined) ?? '')
        const allow = await this.approvals.request({
          id: `${itemId}:${(params.approvalId as string | null) ?? 'command'}`,
          generation: this.snapshot.generation,
          toolCallId: itemId,
          toolName: 'exec_command',
          intent: 'terminal',
          title: command || t('运行命令'),
          detail: [params.reason, params.cwd].filter(Boolean).join('\n')
        })
        return { decision: allow ? 'accept' : 'decline' }
      }
      case 'item/fileChange/requestApproval': {
        const itemId = params.itemId as string
        const node = this.projection.node(itemId)
        const allow = await this.approvals.request({
          id: `${itemId}:patch`,
          generation: this.snapshot.generation,
          toolCallId: itemId,
          toolName: 'apply_patch',
          intent: 'diff',
          title: node?.type === 'tool' ? t('修改 {title}', { title: node.title }) : t('修改文件'),
          detail: [params.reason, node?.type === 'tool' ? node.detail : '']
            .filter(Boolean)
            .join('\n')
        })
        return { decision: allow ? 'accept' : 'decline' }
      }
      case 'account/chatgptAuthTokens/refresh': {
        const account = this.signedInAs
        if (!account) throw new Error('No ChatGPT account is signed in')
        const token = await this.credential<ChatgptAccessToken>({
          kind: 'chatgpt-token',
          accountId: account,
          reason: 'refresh'
        })
        return {
          accessToken: token.accessToken,
          chatgptAccountId: token.chatgptAccountId,
          chatgptPlanType: token.planType
        }
      }
      case 'execCommandApproval':
      case 'applyPatchApproval':
        // Legacy shapes; the v2 requests above carry the same decisions.
        return { decision: 'denied' }
      default:
        throw new Error(t('Pi Desktop 不支持 {method}', { method }))
    }
  }

  // ---------------------------------------------------------------- plumbing

  private async readPrefs(): Promise<Preferences> {
    try {
      return JSON.parse(
        await readFile(join(this.options.storage.config, 'desktop.json'), 'utf8')
      ) as Preferences
    } catch {
      return {}
    }
  }

  private async savePrefs(): Promise<void> {
    await mkdir(this.options.storage.config, { recursive: true })
    await writeFile(
      join(this.options.storage.config, 'desktop.json'),
      JSON.stringify(this.prefs, null, 2),
      { mode: 0o600 }
    )
  }

  private publish(full = false): void {
    this.snapshot.busy = this.running
    if (this.running)
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
      reason: this.running ? t('请先停止当前回合') : !entryId ? t('还没有可以分叉的对话') : null
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
    if (this.running) throw new Error('Stop the current Codex turn before changing the session')
  }

  private assertIdentity(command: { sessionId: string | null; generation: number }): void {
    if (
      command.sessionId !== this.snapshot.sessionId ||
      command.generation !== this.snapshot.generation
    )
      throw new Error('Codex session identity has changed')
  }

  /** Test hook: forget images written for prompts. */
  async clearCache(): Promise<void> {
    await rm(join(this.options.storage.cache, 'images'), { recursive: true, force: true })
  }
}

/** Engine errors in words a user can act on; the original text stays at the end. */
export function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/已不在 Pi 中|没有允许|重新登录/.test(message)) return message
  if (
    /\b401\b|unauthori[sz]ed|invalid[_ ]token|token (?:is )?expired|refresh[_ ]token/i.test(message)
  )
    return t('ChatGPT 登录已失效，请在「设置 › 引擎与账号」重新登录这个账号后再发送（{message}）', {
      message
    })
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|error sending request|stream disconnected|network/i.test(
      message
    )
  )
    return t('连不上模型服务，请检查网络或代理后重试（{message}）', { message })
  return message
}
