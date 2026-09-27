import {
  PLUGIN_HOST_METHODS,
  PLUGIN_STORAGE_MAX_BYTES,
  PLUGIN_TIMEOUTS,
  PluginApiError,
  pluginProcessMessageSchema,
  type PluginErrorCode,
  type PluginHostMethod,
  type PluginProcessMessage
} from '../shared/plugin-api'
import type { PluginCommandSummary, PluginRuntimeStatus } from '../shared/workbench-contracts'
import type { ValidatedPluginCommand } from './workbench-manifest'

/** A spawned plugin process. Main supplies the Electron implementation; tests use fakes. */
export type PluginProcessHandle = {
  postMessage(message: PluginProcessMessage): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  kill(): void
}

export type RuntimePlugin = {
  pluginId: string
  name: string
  canonicalMainPath: string
  granted: ReadonlySet<string>
  commands: readonly ValidatedPluginCommand[]
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
  context(): { projectPath: string | null }
  storage: { get(key: string): unknown; set(key: string, value: unknown): void }
  toast(pluginId: string, message: string): void
  openView(viewId: string): void
  audit(entry: PluginAuditEntry): void
  onChange(): void
  timeouts?: Partial<typeof PLUGIN_TIMEOUTS>
}

type Running = {
  plugin: RuntimePlugin
  handle: PluginProcessHandle
  status: PluginRuntimeStatus
  registered: Set<string>
  nextInvokeId: number
  invokes: Map<number, { resolve: () => void; reject: (error: Error) => void }>
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
export class PluginRuntime {
  private readonly running = new Map<string, Running>()
  private readonly failures = new Map<string, PluginRuntimeStatus>()
  private readonly timeouts: typeof PLUGIN_TIMEOUTS

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

  runCommand(pluginId: string, commandId: string): Promise<void> {
    const running = this.running.get(pluginId)
    if (!running || running.status !== 'running' || !running.registered.has(commandId))
      return Promise.reject(new PluginApiError('NOT_FOUND', '插件命令不可用'))
    const id = running.nextInvokeId++
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        running.invokes.delete(id)
        reject(new PluginApiError('TIMEOUT', '插件命令超时'))
      }, this.timeouts.command)
      running.invokes.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      running.handle.postMessage({ kind: 'invoke', id, target: 'command', name: commandId })
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
      nextInvokeId: 1,
      invokes: new Map(),
      stopping: false
    }
    this.running.set(plugin.pluginId, running)
    handle.onMessage((raw) => this.receive(running, raw))
    handle.onExit(() => this.exited(running))
    running.loadTimer = setTimeout(() => {
      if (running.status !== 'starting') return
      this.fail(running, 'failed', `插件 ${plugin.name} 加载超时`)
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
    this.rejectInvokes(running, new PluginApiError('PLUGIN_CRASHED', '插件已停止'))
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
    this.fail(running, 'crashed', `插件 ${running.plugin.name} 意外退出，已停用它的命令`)
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
        this.fail(running, 'failed', `插件 ${running.plugin.name} 加载失败：${message.message}`)
        return
      case 'reply': {
        const waiter = running.invokes.get(message.id)
        if (!waiter) return
        running.invokes.delete(message.id)
        if (message.ok) waiter.resolve()
        else
          waiter.reject(
            new PluginApiError(message.code ?? 'INTERNAL', message.message ?? '插件命令失败')
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
      const value = await this.execute(running, method, params)
      reply = { kind: 'reply', id, ok: true, value }
      this.dependencies.audit({ pluginId, method, outcome: 'ok' })
    } catch (error) {
      const code: PluginErrorCode = error instanceof PluginApiError ? error.code : 'INTERNAL'
      const message = error instanceof PluginApiError ? error.message : '宿主处理失败'
      reply = { kind: 'reply', id, ok: false, code, message }
      this.dependencies.audit({ pluginId, method: method.slice(0, 128), outcome: code })
    }
    if (this.running.get(pluginId) === running) running.handle.postMessage(reply)
  }

  private async execute(running: Running, method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(PLUGIN_HOST_METHODS, method))
      throw new PluginApiError('UNSUPPORTED', `pi.${method.slice(0, 64)} 在此版本不可用`)
    const spec = PLUGIN_HOST_METHODS[method as PluginHostMethod]
    const parsed = spec.params.safeParse(params)
    if (!parsed.success) throw new PluginApiError('INVALID_ARGUMENT', '参数无效')
    if (spec.permission !== null && !running.plugin.granted.has(spec.permission))
      throw new PluginApiError('PERMISSION_DENIED', `需要权限 ${spec.permission}`)
    const plugin = running.plugin
    const args = parsed.data as Record<string, unknown>
    switch (method as PluginHostMethod) {
      case 'commands.register': {
        const commandId = args.id as string
        if (!plugin.commands.some((command) => command.id === commandId))
          throw new PluginApiError('INVALID_ARGUMENT', '命令必须先在 manifest 中声明')
        running.registered.add(commandId)
        this.dependencies.onChange()
        return undefined
      }
      case 'commands.unregister':
        running.registered.delete(args.id as string)
        this.dependencies.onChange()
        return undefined
      case 'ui.showToast':
        this.dependencies.toast(plugin.pluginId, args.message as string)
        return undefined
      case 'ui.openView': {
        const viewId = plugin.views.get(args.id as string)
        if (!viewId) throw new PluginApiError('NOT_FOUND', '视图未在 manifest 中声明')
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
          throw new PluginApiError('INVALID_ARGUMENT', '存储值必须是不超过 32 KiB 的 JSON')
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
    JSON.stringify([...left.views]) === JSON.stringify([...right.views])
  )
}
