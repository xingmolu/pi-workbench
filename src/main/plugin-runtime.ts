import { AsyncLocalStorage } from 'node:async_hooks'
import {
  PLUGIN_HOST_METHODS,
  PLUGIN_PERMISSIONS,
  PLUGIN_STORAGE_MAX_BYTES,
  PLUGIN_TIMEOUTS,
  PluginApiError,
  pluginToolResultText,
  pluginProcessMessageSchema,
  type PluginErrorCode,
  type PluginHostMethod,
  type PluginProcessMessage
} from '../shared/plugin-api'
import type { PluginCommandSummary, PluginRuntimeStatus } from '../shared/workbench-contracts'
import type { PermissionMode } from '../shared/contracts'
import { isViewCallable } from '../shared/plugin-api'
import type { PluginFileService, PluginGitService } from './plugin-services'
import type { ValidatedPluginCommand } from './workbench-manifest'
import { t } from '../shared/i18n'

/** A spawned plugin process. Main supplies the Electron implementation; tests use fakes. */
export type PluginProcessHandle = {
  postMessage(message: PluginProcessMessage): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

/** What the gateway needs to authorize a call, with or without a running process. */
export type GatewayPlugin = Omit<RuntimePlugin, 'canonicalMainPath'>

export type PluginApprovalRequest = {
  pluginId: string
  pluginName: string
  title: string
  detail: string
}

export type RuntimePlugin = {
  pluginId: string
  name: string
  canonicalMainPath: string
  granted: ReadonlySet<string>
  commands: readonly ValidatedPluginCommand[]
  /** Tool names declared in `contributes.agentTools`. */
  agentTools?: readonly string[]
  /** Local view id → global Workbench view id. */
  views: ReadonlyMap<string, string>
}

export type PluginAuditEntry = {
  pluginId: string
  method: string
  outcome: 'ok' | PluginErrorCode
}

export type PluginRuntimeDependencies = {
  spawn(pluginId: string): PluginProcessHandle
  context(): { projectPath: string | null; permissionMode?: PermissionMode }
  services?: {
    fs: Pick<PluginFileService, 'list' | 'stat' | 'readText' | 'writeText'>
    git: Pick<
      PluginGitService,
      'status' | 'diff' | 'log' | 'stage' | 'unstage' | 'discard' | 'commit' | 'pushPlan' | 'push'
    >
  }
  /** Asks the user in the main window; resolves false when declined or timed out. */
  approve?(request: PluginApprovalRequest): Promise<boolean>
  storage: { get(key: string): unknown; set(key: string, value: unknown): void }
  toast(pluginId: string, message: string): void
  openView(viewId: string): void
  audit(entry: PluginAuditEntry): void
  onChange(): void
  timeouts?: Partial<typeof PLUGIN_TIMEOUTS>
  /** Declared settings merged with stored values; `set` validates against the declaration. */
  settings?: {
    get(pluginId: string): Record<string, unknown>
    set(pluginId: string, values: Record<string, unknown>): Record<string, unknown>
  }
  /** Creates and returns the plugin's private data directory. */
  dataPath?(pluginId: string): Promise<string>
  appearance?(): 'light' | 'dark'
}

type Running = {
  plugin: RuntimePlugin
  handle: PluginProcessHandle
  status: PluginRuntimeStatus
  registered: Set<string>
  tools: Set<string>
  nextInvokeId: number
  invokes: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  loadTimer?: ReturnType<typeof setTimeout>
  stopping: boolean
}

function storageKey(pluginId: string, projectPath: string | null, key: string): string {
  return JSON.stringify([pluginId, projectPath ?? '$app', key])
}

/**
 * Broker between plugin processes and host services. Every `pi.*` call passes, in order:
 * method allowlist → parameter schema → declared-and-granted permission → service → audit.
 */
/** Every refusal is audited, but only high-risk calls when they succeed: panels poll status
 * and reads would otherwise bury the writes that matter. */
function auditsSuccess(method: string): boolean {
  // Unknown methods are the plugin's own panel channels (or refusals, audited on failure).
  if (!Object.hasOwn(PLUGIN_HOST_METHODS, method)) return false
  const permission = PLUGIN_HOST_METHODS[method as PluginHostMethod].permission
  return permission !== null && PLUGIN_PERMISSIONS[permission] === 'high'
}

export class PluginRuntime {
  private readonly running = new Map<string, Running>()
  private readonly failures = new Map<string, PluginRuntimeStatus>()
  private readonly timeouts: typeof PLUGIN_TIMEOUTS
  /** The phone's approver for a call made from its view, instead of the desktop prompt. */
  private readonly remoteApproval = new AsyncLocalStorage<
    NonNullable<PluginRuntimeDependencies['approve']>
  >()

  constructor(private readonly dependencies: PluginRuntimeDependencies) {
    this.timeouts = { ...PLUGIN_TIMEOUTS, ...dependencies.timeouts }
  }

  /** Starts processes for newly enabled plugins and stops ones no longer enabled or changed. */
  sync(plugins: readonly RuntimePlugin[]): void {
    const wanted = new Map(plugins.map((plugin) => [plugin.pluginId, plugin]))
    for (const [pluginId, running] of this.running) {
      const next = wanted.get(pluginId)
      if (!next || !samePlugin(running.plugin, next)) this.stop(pluginId)
    }
    for (const plugin of plugins) {
      if (!this.running.has(plugin.pluginId)) this.start(plugin)
    }
    for (const pluginId of [...this.failures.keys()])
      if (!wanted.has(pluginId)) this.failures.delete(pluginId)
  }

  status(pluginId: string): PluginRuntimeStatus {
    return this.running.get(pluginId)?.status ?? this.failures.get(pluginId) ?? 'stopped'
  }

  /** Commands declared in a manifest and registered by the running plugin. */
  commands(): PluginCommandSummary[] {
    const commands: PluginCommandSummary[] = []
    for (const { plugin, registered, status } of this.running.values()) {
      if (status !== 'running') continue
      for (const command of plugin.commands)
        if (registered.has(command.id))
          commands.push({
            pluginId: plugin.pluginId,
            pluginName: plugin.name,
            commandId: command.id,
            title: command.title,
            keywords: [...command.keywords]
          })
    }
    return commands
  }

  async runCommand(pluginId: string, commandId: string): Promise<void> {
    const running = this.running.get(pluginId)
    if (!running || running.status !== 'running' || !running.registered.has(commandId))
      throw new PluginApiError('NOT_FOUND', t('插件命令不可用'))
    await this.invoke(
      running,
      'command',
      commandId,
      undefined,
      this.timeouts.command,
      t('插件命令超时')
    )
  }

  /** Runs a plugin agent tool and returns its result as text for the model. */
  async runTool(
    pluginId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<string> {
    const running = this.running.get(pluginId)
    if (!running || running.status !== 'running')
      throw new PluginApiError('NOT_FOUND', t('插件未运行'))
    if (!running.plugin.granted.has('agent.tools'))
      throw new PluginApiError('PERMISSION_DENIED', t('需要权限 agent.tools'))
    if (!running.tools.has(name)) throw new PluginApiError('NOT_FOUND', t('插件工具尚未就绪'))
    try {
      const value = await this.invoke(
        running,
        'tool',
        name,
        input ?? {},
        this.timeouts.tool,
        t('插件工具超时'),
        signal
      )
      this.dependencies.audit({ pluginId, method: `tool:${name}`, outcome: 'ok' })
      return pluginToolResultText(value)
    } catch (error) {
      const code: PluginErrorCode = error instanceof PluginApiError ? error.code : 'INTERNAL'
      this.dependencies.audit({ pluginId, method: `tool:${name}`, outcome: code })
      throw error instanceof PluginApiError
        ? error
        : new PluginApiError('INTERNAL', t('插件工具失败'))
    }
  }

  private invoke(
    running: Running,
    target: 'command' | 'tool' | 'panel',
    name: string,
    input: unknown,
    timeout: number,
    timeoutMessage: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new PluginApiError('CONFLICT', t('调用已取消')))
    const id = running.nextInvokeId++
    return new Promise<unknown>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        running.invokes.delete(id)
      }
      const onAbort = (): void => {
        settle()
        reject(new PluginApiError('CONFLICT', t('调用已取消')))
      }
      const timer = setTimeout(() => {
        settle()
        reject(new PluginApiError('TIMEOUT', timeoutMessage))
      }, timeout)
      signal?.addEventListener('abort', onAbort, { once: true })
      running.invokes.set(id, {
        resolve: (value) => {
          settle()
          resolve(value)
        },
        reject: (error) => {
          settle()
          reject(error)
        }
      })
      running.handle.postMessage({
        kind: 'invoke',
        id,
        target,
        name,
        ...(target === 'command' ? {} : { input })
      })
    })
  }

  dispose(): void {
    for (const pluginId of [...this.running.keys()]) this.stop(pluginId)
  }

  private start(plugin: RuntimePlugin): void {
    this.failures.delete(plugin.pluginId)
    let handle: PluginProcessHandle
    try {
      handle = this.dependencies.spawn(plugin.pluginId)
    } catch {
      this.failures.set(plugin.pluginId, 'failed')
      this.dependencies.onChange()
      return
    }
    const running: Running = {
      plugin,
      handle,
      status: 'starting',
      registered: new Set(),
      tools: new Set(),
      nextInvokeId: 1,
      invokes: new Map(),
      stopping: false
    }
    this.running.set(plugin.pluginId, running)
    handle.onMessage((raw) => this.receive(running, raw))
    handle.onExit(() => this.exited(running))
    running.loadTimer = setTimeout(() => {
      if (running.status !== 'starting') return
      this.fail(running, 'failed', t('插件 {name} 加载超时', { name: plugin.name }))
    }, this.timeouts.load)
    handle.postMessage({
      kind: 'load',
      pluginId: plugin.pluginId,
      mainPath: plugin.canonicalMainPath
    })
    this.dependencies.onChange()
  }

  private stop(pluginId: string): void {
    const running = this.running.get(pluginId)
    if (!running) return
    running.stopping = true
    this.running.delete(pluginId)
    clearTimeout(running.loadTimer)
    this.rejectInvokes(running, new PluginApiError('PLUGIN_CRASHED', t('插件已停止')))
    try {
      running.handle.postMessage({ kind: 'unload' })
    } catch {
      /* Already gone. */
    }
    const killer = setTimeout(() => running.handle.kill(), this.timeouts.unload)
    running.handle.onExit(() => clearTimeout(killer))
    this.dependencies.onChange()
  }

  private fail(running: Running, status: 'crashed' | 'failed', message: string): void {
    if (this.running.get(running.plugin.pluginId) !== running) return
    this.running.delete(running.plugin.pluginId)
    clearTimeout(running.loadTimer)
    running.stopping = true
    this.rejectInvokes(running, new PluginApiError('PLUGIN_CRASHED', message))
    this.failures.set(running.plugin.pluginId, status)
    try {
      running.handle.kill()
    } catch {
      /* Already gone. */
    }
    this.dependencies.toast(running.plugin.pluginId, message)
    this.dependencies.onChange()
  }

  private exited(running: Running): void {
    if (running.stopping) return
    this.fail(
      running,
      'crashed',
      t('插件 {name} 意外退出，已停用它的命令', { name: running.plugin.name })
    )
  }

  private rejectInvokes(running: Running, error: Error): void {
    for (const waiter of running.invokes.values()) waiter.reject(error)
    running.invokes.clear()
  }

  private receive(running: Running, raw: unknown): void {
    if (this.running.get(running.plugin.pluginId) !== running) return
    const parsed = pluginProcessMessageSchema.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    switch (message.kind) {
      case 'ready':
        if (running.status !== 'starting') return
        clearTimeout(running.loadTimer)
        running.status = 'running'
        this.dependencies.onChange()
        return
      case 'load-failed':
        this.fail(
          running,
          'failed',
          t('插件 {name} 加载失败：{message}', {
            name: running.plugin.name,
            message: message.message
          })
        )
        return
      case 'reply': {
        const waiter = running.invokes.get(message.id)
        if (!waiter) return
        running.invokes.delete(message.id)
        if (message.ok) waiter.resolve(message.value)
        else
          waiter.reject(
            new PluginApiError(message.code ?? 'INTERNAL', message.message ?? t('插件命令失败'))
          )
        return
      }
      case 'call':
        void this.call(running, message.id, message.method, message.params)
        return
      default:
        return
    }
  }

  private async call(running: Running, id: number, method: string, params: unknown): Promise<void> {
    const pluginId = running.plugin.pluginId
    let reply: PluginProcessMessage
    try {
      const value = await this.execute(running.plugin, running, method, params)
      reply = { kind: 'reply', id, ok: true, value }
      if (auditsSuccess(method)) this.dependencies.audit({ pluginId, method, outcome: 'ok' })
    } catch (error) {
      const code: PluginErrorCode = error instanceof PluginApiError ? error.code : 'INTERNAL'
      const message = error instanceof PluginApiError ? error.message : t('宿主处理失败')
      reply = { kind: 'reply', id, ok: false, code, message }
      this.dependencies.audit({ pluginId, method: method.slice(0, 128), outcome: code })
    }
    if (this.running.get(pluginId) === running) running.handle.postMessage(reply)
  }

  /**
   * A call from one of the plugin's sandboxed views. Same gateway, same audit, no commands.
   * A view on the phone passes its own `approve` so confirmations happen where the user is,
   * and never reaches the plugin process's own channels.
   */
  async callFromView(
    plugin: GatewayPlugin,
    method: string,
    params: unknown,
    remote?: { approve: NonNullable<PluginRuntimeDependencies['approve']> }
  ): Promise<unknown> {
    try {
      if (Object.hasOwn(PLUGIN_HOST_METHODS, method) && !isViewCallable(method as PluginHostMethod))
        throw new PluginApiError('UNSUPPORTED', t('面板不能调用此方法'))
      if (remote && !Object.hasOwn(PLUGIN_HOST_METHODS, method))
        throw new PluginApiError('UNSUPPORTED', t('手机端暂不支持插件自定义调用'))
      // Channels the host does not implement go to the plugin's own `onPanelInvoke`.
      const running = this.running.get(plugin.pluginId)
      const value =
        !Object.hasOwn(PLUGIN_HOST_METHODS, method) && running?.status === 'running'
          ? await this.invoke(
              running,
              'panel',
              method.slice(0, 128),
              params ?? {},
              this.timeouts.command,
              t('插件面板调用超时')
            )
          : remote
            ? await this.remoteApproval.run(remote.approve, () =>
                this.execute(plugin, null, method, params)
              )
            : await this.execute(plugin, null, method, params)
      if (auditsSuccess(method))
        this.dependencies.audit({ pluginId: plugin.pluginId, method, outcome: 'ok' })
      return value
    } catch (error) {
      const code: PluginErrorCode = error instanceof PluginApiError ? error.code : 'INTERNAL'
      this.dependencies.audit({
        pluginId: plugin.pluginId,
        method: method.slice(0, 128),
        outcome: code
      })
      throw error instanceof PluginApiError
        ? error
        : new PluginApiError('INTERNAL', t('宿主处理失败'))
    }
  }

  private project(): string {
    const { projectPath } = this.dependencies.context()
    if (!projectPath) throw new PluginApiError('NOT_FOUND', t('没有打开的项目'))
    return projectPath
  }

  /** Plugin writes follow the project's approval level: ask confirms, auto confirms only
   * destructive actions, full access never confirms. Confirmation is never optional for
   * a destructive action outside full access, and never optional at all for actions that
   * leave the machine (`always`). */
  private async confirm(
    plugin: GatewayPlugin,
    title: string,
    detail: string,
    level: boolean | 'always'
  ): Promise<void> {
    const mode = this.dependencies.context().permissionMode ?? 'ask'
    if (level !== 'always' && (mode === 'open' || (mode === 'auto' && !level))) return
    const approve = this.remoteApproval.getStore() ?? this.dependencies.approve
    const approved = await (approve?.({
      pluginId: plugin.pluginId,
      pluginName: plugin.name,
      title,
      detail
    }) ?? Promise.resolve(false))
    if (!approved) throw new PluginApiError('PERMISSION_DENIED', t('用户拒绝了这次操作'))
  }

  /** The approved target must still be the open project when the write happens. */
  private assertProject(project: string): void {
    if (this.dependencies.context().projectPath !== project)
      throw new PluginApiError('CONFLICT', t('项目已切换，操作已取消'))
  }

  private services(): NonNullable<PluginRuntimeDependencies['services']> {
    const services = this.dependencies.services
    if (!services) throw new PluginApiError('UNSUPPORTED', t('此环境未提供文件与 Git 服务'))
    return services
  }

  private async execute(
    plugin: GatewayPlugin,
    registry: Pick<Running, 'registered' | 'tools'> | null,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (!Object.hasOwn(PLUGIN_HOST_METHODS, method))
      throw new PluginApiError(
        'UNSUPPORTED',
        t('pi.{value} 在此版本不可用', { value: method.slice(0, 64) })
      )
    const spec = PLUGIN_HOST_METHODS[method as PluginHostMethod]
    const parsed = spec.params.safeParse(params)
    if (!parsed.success) throw new PluginApiError('INVALID_ARGUMENT', t('参数无效'))
    if (spec.permission !== null && !plugin.granted.has(spec.permission))
      throw new PluginApiError(
        'PERMISSION_DENIED',
        t('需要权限 {permission}', { permission: spec.permission })
      )
    const args = parsed.data as Record<string, unknown>
    switch (method as PluginHostMethod) {
      case 'commands.register': {
        const commandId = args.id as string
        if (!registry) throw new PluginApiError('UNSUPPORTED', t('面板不能注册命令'))
        if (!plugin.commands.some((command) => command.id === commandId))
          throw new PluginApiError('INVALID_ARGUMENT', t('命令必须先在 manifest 中声明'))
        registry.registered.add(commandId)
        this.dependencies.onChange()
        return undefined
      }
      case 'commands.unregister':
        registry?.registered.delete(args.id as string)
        this.dependencies.onChange()
        return undefined
      case 'agent.registerTool': {
        if (!registry) throw new PluginApiError('UNSUPPORTED', t('面板不能注册工具'))
        const name = args.name as string
        if (!(plugin.agentTools ?? []).includes(name))
          throw new PluginApiError('INVALID_ARGUMENT', t('工具必须先在 manifest 中声明'))
        registry.tools.add(name)
        return undefined
      }
      case 'fs.list':
        return this.services().fs.list(this.project(), args.path as string)
      case 'fs.stat':
        return this.services().fs.stat(this.project(), args.path as string)
      case 'fs.readText':
        return this.services().fs.readText(this.project(), args.path as string)
      case 'fs.writeText': {
        const project = this.project()
        await this.confirm(
          plugin,
          t('写入 {value}', { value: args.path as string }),
          t('{length} 个字符', { length: (args.content as string).length }),
          false
        )
        this.assertProject(project)
        await this.services().fs.writeText(project, args.path as string, args.content as string)
        return undefined
      }
      case 'git.status':
        return this.services().git.status(this.project())
      case 'git.diff':
        return this.services().git.diff(
          this.project(),
          args.path as string | undefined,
          args.staged as boolean
        )
      case 'git.log':
        return this.services().git.log(this.project(), args.limit as number)
      case 'git.stage': {
        const project = this.project()
        const paths = args.paths as string[]
        await this.confirm(
          plugin,
          t('暂存 {length} 个文件', { length: paths.length }),
          paths.join('\n'),
          false
        )
        this.assertProject(project)
        await this.services().git.stage(project, paths)
        return undefined
      }
      case 'git.unstage': {
        const project = this.project()
        const paths = args.paths as string[]
        await this.confirm(
          plugin,
          t('取消暂存 {length} 个文件', { length: paths.length }),
          paths.join('\n'),
          false
        )
        this.assertProject(project)
        await this.services().git.unstage(project, paths)
        return undefined
      }
      case 'git.discard': {
        const project = this.project()
        const paths = args.paths as string[]
        await this.confirm(
          plugin,
          t('丢弃 {length} 个文件的未暂存改动', { length: paths.length }),
          paths.join('\n'),
          true
        )
        this.assertProject(project)
        await this.services().git.discard(project, paths)
        return undefined
      }
      case 'git.commit': {
        const project = this.project()
        await this.confirm(plugin, t('提交暂存的改动'), args.message as string, false)
        this.assertProject(project)
        return this.services().git.commit(project, args.message as string)
      }
      case 'git.push': {
        const project = this.project()
        const plan = await this.services().git.pushPlan(project)
        const commits = plan.commits.map(({ hash, subject }) => `${hash.slice(0, 7)} ${subject}`)
        if (plan.moreCommits > 0)
          commits.push(t('…另外 {moreCommits} 个提交', { moreCommits: plan.moreCommits }))
        await this.confirm(
          plugin,
          t('推送 {branch} 到 {remote}/{remoteBranch}', {
            branch: plan.branch,
            remote: plan.remote,
            remoteBranch: plan.remoteBranch
          }),
          [
            t('远程：{remote}  {url}', { remote: plan.remote, url: plan.url }),
            plan.setUpstream
              ? t('将新建远程分支 {remoteBranch} 并设为上游', { remoteBranch: plan.remoteBranch })
              : null,
            '',
            ...(commits.length > 0 ? commits : [t('没有新的提交')])
          ]
            .filter((line) => line !== null)
            .join('\n'),
          'always'
        )
        this.assertProject(project)
        return this.services().git.push(plan)
      }
      case 'ui.showToast':
      case 'ui.notify':
        this.dependencies.toast(plugin.pluginId, args.message as string)
        return undefined
      case 'ui.openPanel': {
        const viewId = plugin.views.get('panel') ?? [...plugin.views.values()][0]
        if (!viewId) throw new PluginApiError('NOT_FOUND', t('插件没有可打开的面板'))
        this.dependencies.openView(viewId)
        return undefined
      }
      case 'agent.unregisterTool':
        registry?.tools.delete(args.name as string)
        return undefined
      case 'plugin.getSettings':
        return this.dependencies.settings?.get(plugin.pluginId) ?? {}
      case 'plugin.setSettings': {
        if (!this.dependencies.settings)
          throw new PluginApiError('UNSUPPORTED', t('插件设置不可用'))
        return this.dependencies.settings.set(
          plugin.pluginId,
          args.values as Record<string, unknown>
        )
      }
      case 'plugin.getDataPath': {
        if (!this.dependencies.dataPath)
          throw new PluginApiError('UNSUPPORTED', t('插件数据目录不可用'))
        return this.dependencies.dataPath(plugin.pluginId)
      }
      case 'workspace.get': {
        const { projectPath } = this.dependencies.context()
        return projectPath
          ? {
              path: projectPath,
              name: projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
            }
          : null
      }
      case 'app.getAppearance':
        return { base: this.dependencies.appearance?.() ?? 'dark' }
      case 'ui.openView': {
        const viewId = plugin.views.get(args.id as string)
        if (!viewId) throw new PluginApiError('NOT_FOUND', t('视图未在 manifest 中声明'))
        this.dependencies.openView(viewId)
        return undefined
      }
      case 'project.current': {
        const { projectPath } = this.dependencies.context()
        return { path: projectPath }
      }
      case 'storage.get':
        return (
          this.dependencies.storage.get(
            storageKey(plugin.pluginId, this.dependencies.context().projectPath, args.key as string)
          ) ?? null
        )
      case 'storage.set': {
        let encoded: string | undefined
        try {
          encoded = JSON.stringify(args.value)
        } catch {
          encoded = undefined
        }
        if (encoded === undefined || Buffer.byteLength(encoded) > PLUGIN_STORAGE_MAX_BYTES)
          throw new PluginApiError('INVALID_ARGUMENT', t('存储值必须是不超过 32 KiB 的 JSON'))
        this.dependencies.storage.set(
          storageKey(plugin.pluginId, this.dependencies.context().projectPath, args.key as string),
          JSON.parse(encoded)
        )
        return undefined
      }
    }
  }
}

function samePlugin(left: RuntimePlugin, right: RuntimePlugin): boolean {
  return (
    left.canonicalMainPath === right.canonicalMainPath &&
    left.granted.size === right.granted.size &&
    [...left.granted].every((permission) => right.granted.has(permission)) &&
    JSON.stringify(left.commands) === JSON.stringify(right.commands) &&
    JSON.stringify(left.agentTools ?? []) === JSON.stringify(right.agentTools ?? []) &&
    JSON.stringify([...left.views]) === JSON.stringify([...right.views])
  )
}
