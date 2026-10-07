/**
 * Plugin process entry. One process per plugin, forked by Main with `utilityProcess.fork`.
 * Plugin code receives a global `pi` whose methods are RPC stubs; it holds no host object.
 * This is not an OS sandbox: plugin code can still use Node directly (see PLUGINS.md §1).
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  pluginProcessMessageSchema,
  type PluginErrorCode,
  type PluginProcessMessage
} from '../shared/plugin-api'

type Port = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}
const port = (process as unknown as { parentPort?: Port }).parentPort
if (!port) throw new Error('Plugin host must run as a utility process')

type PluginModule = {
  onLoad?: () => unknown
  onUnload?: () => unknown
  /** View channels the host does not implement arrive here. */
  onPanelInvoke?: (channel: string, payload: unknown) => unknown
}
type CommandHandler = () => unknown
type ToolContext = { log(message: string): void; pluginId: string }
type ToolHandler = (input: unknown, context: ToolContext) => unknown

let nextCallId = 1
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
const commands = new Map<string, CommandHandler>()
const tools = new Map<string, ToolHandler>()
let plugin: PluginModule | null = null
let pluginId = ''

function send(message: PluginProcessMessage): void {
  port!.postMessage(message)
}

class HostError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PluginApiError'
  }
}

function call(method: string, params: unknown = {}): Promise<unknown> {
  const id = nextCallId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ kind: 'call', id, method, params })
  })
}

const pi = Object.freeze({
  commands: Object.freeze({
    async register(command: { id: string; run: CommandHandler }): Promise<void> {
      if (!command || typeof command.run !== 'function')
        throw new HostError('INVALID_ARGUMENT', 'commands.register requires a run function')
      await call('commands.register', { id: command.id })
      commands.set(command.id, command.run)
    },
    async unregister(id: string): Promise<void> {
      commands.delete(id)
      await call('commands.unregister', { id })
    }
  }),
  ui: Object.freeze({
    showToast: (message: string | { message: string }) =>
      call('ui.showToast', { message: typeof message === 'string' ? message : message?.message }),
    notify: (message: string | { message: string }) =>
      call('ui.notify', { message: typeof message === 'string' ? message : message?.message }),
    openView: (id: string) => call('ui.openView', { id }),
    /** Floating panels open as the plugin's view in the work panel. */
    openPanel: () => call('ui.openPanel', {})
  }),
  plugin: Object.freeze({
    getId: () => pluginId,
    getSettings: () => call('plugin.getSettings'),
    setSettings: (values: Record<string, unknown>) => call('plugin.setSettings', { values }),
    getDataPath: () => call('plugin.getDataPath')
  }),
  /**
   * A message bus and resident services are not implemented. They are accepted
   * as no-ops so plugins that use them still load; settings shows that they were ignored.
   */
  bus: Object.freeze({
    publish: async (): Promise<void> => undefined,
    subscribe: async (): Promise<() => Promise<void>> => async () => undefined
  }),
  services: Object.freeze({
    register: (): void => undefined,
    unregister: (): void => undefined
  }),
  storage: Object.freeze({
    get: (key: string) => call('storage.get', { key }),
    set: (key: string, value: unknown) => call('storage.set', { key, value })
  }),
  project: Object.freeze({
    current: () => call('project.current')
  }),
  fs: Object.freeze({
    list: (path = '.') => call('fs.list', { path }),
    stat: (path: string) => call('fs.stat', { path }),
    readText: (path: string) => call('fs.readText', { path }),
    writeText: (path: string, content: string) => call('fs.writeText', { path, content })
  }),
  ai: Object.freeze({
    complete: (request: { system?: string; prompt: string; maxTokens?: number }) =>
      call('ai.complete', request)
  }),
  git: Object.freeze({
    status: () => call('git.status'),
    diff: (options: { path?: string; staged?: boolean } = {}) => call('git.diff', options),
    log: (options: { limit?: number } = {}) => call('git.log', options),
    stage: (paths: string[]) => call('git.stage', { paths }),
    unstage: (paths: string[]) => call('git.unstage', { paths }),
    discard: (paths: string[]) => call('git.discard', { paths }),
    commit: (message: string) => call('git.commit', { message }),
    push: () => call('git.push')
  }),
  agent: Object.freeze({
    /** `run(input, context)` (or `execute`) returns a string,
     * `{ content: [{ type: 'text', text }] }`, or JSON data. */
    async registerTool(tool: {
      name: string
      run?: ToolHandler
      execute?: ToolHandler
    }): Promise<void> {
      const handler = tool?.run ?? tool?.execute
      if (typeof handler !== 'function')
        throw new HostError('INVALID_ARGUMENT', 'agent.registerTool requires a run function')
      await call('agent.registerTool', { name: tool.name })
      tools.set(tool.name, handler)
    },
    async unregisterTool(name: string): Promise<void> {
      tools.delete(name)
      await call('agent.unregisterTool', { name })
    }
  })
})
;(globalThis as Record<string, unknown>).pi = pi

function errorReply(id: number, error: unknown): PluginProcessMessage {
  const code = error instanceof HostError ? error.code : 'INTERNAL'
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'reply', id, ok: false, code, message: message.slice(0, 2000) }
}

async function load(mainPath: string): Promise<void> {
  try {
    let loaded: unknown
    try {
      loaded = createRequire(mainPath)(mainPath)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ERR_REQUIRE_ESM') throw error
      loaded = await import(pathToFileURL(mainPath).href)
    }
    const candidate = loaded as PluginModule & { default?: PluginModule }
    plugin = typeof candidate.onLoad === 'function' ? candidate : (candidate.default ?? candidate)
    await plugin.onLoad?.()
    send({ kind: 'ready' })
  } catch (error) {
    send({
      kind: 'load-failed',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    })
  }
}

port.on('message', (event) => {
  const parsed = pluginProcessMessageSchema.safeParse(event.data)
  if (!parsed.success) return
  const message = parsed.data
  switch (message.kind) {
    case 'load':
      pluginId = message.pluginId
      void load(message.mainPath)
      break
    case 'reply': {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.value)
      else
        waiter.reject(
          new HostError(message.code ?? 'INTERNAL', message.message ?? 'Host call failed')
        )
      break
    }
    case 'invoke': {
      if (message.target === 'panel') {
        const handler = plugin?.onPanelInvoke
        if (typeof handler !== 'function') {
          send(
            errorReply(
              message.id,
              new HostError('UNSUPPORTED', `Channel ${message.name} is not handled`)
            )
          )
          return
        }
        void Promise.resolve()
          .then(() => handler.call(plugin, message.name, message.input))
          .then(
            (value) => send({ kind: 'reply', id: message.id, ok: true, value }),
            (error: unknown) => send(errorReply(message.id, error))
          )
        return
      }
      if (message.target === 'tool') {
        const handler = tools.get(message.name)
        if (!handler) {
          send(
            errorReply(
              message.id,
              new HostError('NOT_FOUND', `Tool ${message.name} is not registered`)
            )
          )
          return
        }
        void Promise.resolve()
          .then(() =>
            handler(message.input, {
              pluginId,
              log: (text: string) => console.log(`[${pluginId}] ${String(text).slice(0, 2000)}`)
            })
          )
          .then(
            (value) => send({ kind: 'reply', id: message.id, ok: true, value }),
            (error: unknown) => send(errorReply(message.id, error))
          )
        return
      }
      const handler = commands.get(message.name)
      if (!handler) {
        send(
          errorReply(
            message.id,
            new HostError('NOT_FOUND', `Command ${message.name} is not registered`)
          )
        )
        return
      }
      void Promise.resolve()
        .then(handler)
        .then(
          () => send({ kind: 'reply', id: message.id, ok: true }),
          (error: unknown) => send(errorReply(message.id, error))
        )
      break
    }
    case 'unload':
      void Promise.resolve()
        .then(() => plugin?.onUnload?.())
        .finally(() => process.exit(0))
      break
  }
})
