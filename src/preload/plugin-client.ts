import type {
  PluginPanelAPI,
  PluginPanelCommand,
  PluginPanelCommandResult,
  PluginPanelContext
} from '../shared/workbench-contracts'
import {
  pluginPanelCommandResultSchema,
  pluginPanelCommandSchema,
  pluginPanelContextSchema,
  pluginPanelStateSchema
} from '../shared/workbench-schemas'

export type PluginPanelTransport = {
  invoke(command: PluginPanelCommand): Promise<unknown>
  onContext(listener: (context: unknown) => void): () => void
}

function invalid(message: string): Error {
  return new Error(message)
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

export function createPluginPanelClient(transport: PluginPanelTransport): PluginPanelAPI {
  let cachedContext: PluginPanelContext | null = null

  const acceptContext = (value: unknown): PluginPanelContext => {
    const parsed = pluginPanelContextSchema.safeParse(value)
    if (!parsed.success) throw invalid('Workbench panel context is invalid')
    const next = parsed.data
    if (cachedContext) {
      if (next.pluginId !== cachedContext.pluginId || next.viewId !== cachedContext.viewId) {
        throw invalid('Workbench panel context is stale')
      }
      if (
        next.generation < cachedContext.generation ||
        (next.generation === cachedContext.generation && !contextsEqual(next, cachedContext))
      ) {
        throw invalid('Workbench panel context is stale')
      }
    }
    cachedContext = next
    return next
  }

  const invoke = async (command: PluginPanelCommand): Promise<PluginPanelCommandResult> => {
    const parsedCommand = pluginPanelCommandSchema.safeParse(command)
    if (!parsedCommand.success) throw invalid('Workbench panel command is invalid')
    try {
      return pluginPanelCommandResultSchema.parse(await transport.invoke(parsedCommand.data))
    } catch {
      throw invalid('Workbench panel response is invalid')
    }
  }

  const getContext = async (): Promise<PluginPanelContext> => {
    const result = await invoke({ type: 'context:get' })
    if (result.type !== 'context') throw invalid('Workbench panel response is invalid')
    return acceptContext(result.context)
  }

  const contextForGeneration = async (generation: number): Promise<PluginPanelContext> => {
    const context = cachedContext ?? (await getContext())
    if (context.generation !== generation) throw invalid('Workbench panel generation is stale')
    return context
  }

  const assertCurrentResponse = (
    expected: PluginPanelContext,
    actual: PluginPanelContext
  ): void => {
    if (
      !contextsEqual(expected, actual) ||
      !cachedContext ||
      !contextsEqual(cachedContext, actual)
    ) {
      throw invalid('Workbench panel context is stale')
    }
  }

  return Object.freeze({
    getContext,
    async getState(generation) {
      const context = await contextForGeneration(generation)
      const result = await invoke({ type: 'state:get', context })
      if (result.type !== 'state') throw invalid('Workbench panel response is invalid')
      assertCurrentResponse(context, result.context)
      return result.value
    },
    async setState(generation, value) {
      const parsedState = pluginPanelStateSchema.safeParse(value)
      if (!parsedState.success) throw invalid('Workbench panel state is invalid')
      const context = await contextForGeneration(generation)
      const result = await invoke({ type: 'state:set', context, value: parsedState.data })
      if (result.type !== 'state:stored') throw invalid('Workbench panel response is invalid')
      assertCurrentResponse(context, result.context)
    },
    async call(method, params = {}) {
      const context = cachedContext ?? (await getContext())
      const result = await invoke({ type: 'api:call', context, method, params })
      if (result.type !== 'api:result') throw invalid('Workbench panel response is invalid')
      if (result.ok) return result.value ?? null
      // contextBridge clones Error objects as message-only; a plain object keeps `code`.
      throw Object.freeze({
        name: 'PluginApiError',
        code: result.code ?? 'INTERNAL',
        message: result.message ?? 'Plugin call failed'
      })
    },
    onContext(listener) {
      return transport.onContext((value) => {
        try {
          listener(acceptContext(value))
        } catch {
          // Invalid, stale, or cross-panel context events are ignored.
        }
      })
    }
  })
}
