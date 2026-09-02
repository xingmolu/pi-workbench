import type {
  PluginPanelCommand,
  PluginPanelCommandResult,
  PluginPanelContext
} from '../shared/workbench-contracts'
import {
  pluginPanelCommandResultSchema,
  pluginPanelCommandSchema,
  pluginPanelContextSchema
} from '../shared/workbench-schemas'
import type { WorkbenchHost, WorkbenchPanelStateAdapter } from './workbench-host'

export type WorkbenchPanelIpcSender = {
  readonly mainFrame: object
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export type WorkbenchPanelIpcEvent = {
  sender: WorkbenchPanelIpcSender
  senderFrame: object | null
}

export type WorkbenchPanelIpcRouter = {
  bind(sender: WorkbenchPanelIpcSender, host: WorkbenchHost, viewId: string): () => void
  unbindHost(host: WorkbenchHost): void
  handle(event: WorkbenchPanelIpcEvent, command: unknown): Promise<PluginPanelCommandResult>
}

type Binding = {
  token: object
  sender: WorkbenchPanelIpcSender
  host: WorkbenchHost
  viewId: string
  pluginId: string
  adapter: WorkbenchPanelStateAdapter
  onDestroyed: () => void
}

class WorkbenchPanelRequestError extends Error {}

function requestError(message: string): WorkbenchPanelRequestError {
  return new WorkbenchPanelRequestError(message)
}

function contextsEqual(left: PluginPanelContext, right: PluginPanelContext): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.viewId === right.viewId &&
    left.projectPath === right.projectPath &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation
  )
}

export function createWorkbenchPanelIpcRouter(dependencies: {
  createAdapter(host: WorkbenchHost, viewId: string): WorkbenchPanelStateAdapter
}): WorkbenchPanelIpcRouter {
  const bindings = new WeakMap<WorkbenchPanelIpcSender, Binding>()
  const hostBindings = new Map<WorkbenchHost, Set<Binding>>()

  const removeBinding = (binding: Binding): void => {
    if (bindings.get(binding.sender)?.token !== binding.token) return
    bindings.delete(binding.sender)
    binding.sender.removeListener('destroyed', binding.onDestroyed)
    const owned = hostBindings.get(binding.host)
    owned?.delete(binding)
    if (owned?.size === 0) hostBindings.delete(binding.host)
  }

  const currentContext = (binding: Binding): PluginPanelContext => {
    const parsed = pluginPanelContextSchema.safeParse(binding.adapter.context())
    if (
      !parsed.success ||
      parsed.data.pluginId !== binding.pluginId ||
      parsed.data.viewId !== binding.viewId
    ) {
      throw requestError('Workbench panel context is stale')
    }
    return parsed.data
  }

  const route = (binding: Binding, command: PluginPanelCommand): PluginPanelCommandResult => {
    const context = currentContext(binding)
    if (command.type === 'context:get') return { type: 'context', context }
    if (!contextsEqual(command.context, context)) {
      throw requestError('Workbench panel context is stale')
    }
    if (command.type === 'state:get') {
      return {
        type: 'state',
        context,
        value: binding.adapter.getState(context)
      }
    }
    binding.adapter.setState(context, command.value)
    return { type: 'state:stored', context }
  }

  return {
    bind(sender, host, viewId) {
      const previous = bindings.get(sender)
      if (previous) removeBinding(previous)

      const adapter = dependencies.createAdapter(host, viewId)
      const context = pluginPanelContextSchema.safeParse(adapter.context())
      if (!context.success || context.data.viewId !== viewId) {
        throw requestError('Workbench panel binding is unavailable')
      }
      const token = {}
      const binding: Binding = {
        token,
        sender,
        host,
        viewId,
        pluginId: context.data.pluginId,
        adapter,
        onDestroyed: () => removeBinding(binding)
      }
      bindings.set(sender, binding)
      const owned = hostBindings.get(host) ?? new Set<Binding>()
      owned.add(binding)
      hostBindings.set(host, owned)
      sender.once('destroyed', binding.onDestroyed)
      return () => removeBinding(binding)
    },
    unbindHost(host) {
      for (const binding of [...(hostBindings.get(host) ?? [])]) removeBinding(binding)
    },
    async handle(event, command) {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw requestError('Workbench panel requests require the main frame')
      }
      const binding = bindings.get(event.sender)
      if (!binding) throw requestError('Workbench panel sender is not bound')
      const parsed = pluginPanelCommandSchema.safeParse(command)
      if (!parsed.success) throw requestError('Workbench panel request is invalid')

      try {
        return pluginPanelCommandResultSchema.parse(route(binding, parsed.data))
      } catch (error) {
        if (error instanceof WorkbenchPanelRequestError) throw error
        throw requestError('Workbench panel request failed')
      }
    }
  }
}
