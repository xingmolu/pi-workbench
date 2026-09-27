import { realpath } from 'node:fs/promises'
import {
  EMPTY_PLUGIN_AGENT_CONTRIBUTIONS,
  pluginAgentRequestSchema,
  type PluginAgentContributions,
  type PluginAgentResponse
} from '../shared/plugin-agent'

export type PluginAgentBridgeDependencies = {
  contributions(): Promise<PluginAgentContributions | null>
  runTool(pluginId: string, name: string, input: unknown, signal: AbortSignal): Promise<string>
  /** The project open in the main window; plugin host APIs act on it. */
  foregroundProject(): string | null
  canonicalize?(path: string): Promise<string>
}

/**
 * Answers Agent Host requests for plugin contributions and runs plugin tools for it.
 * A plugin's `pi.fs` / `pi.git` act on the project open in the window, so a tool call from a
 * session in another project is refused instead of silently touching the wrong one.
 */
export class PluginAgentBridge {
  private readonly calls = new Map<string, AbortController>()

  constructor(private readonly dependencies: PluginAgentBridgeDependencies) {}

  /** Returns true when the message belonged to this bridge. */
  handle(owner: string, message: unknown, reply: (response: PluginAgentResponse) => void): boolean {
    const parsed = pluginAgentRequestSchema.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    switch (request.type) {
      case 'plugin-agent-contributions-request':
        void this.dependencies
          .contributions()
          .catch(() => null)
          .then((contributions) =>
            reply({
              type: 'plugin-agent-contributions',
              requestId: request.requestId,
              contributions: contributions ?? EMPTY_PLUGIN_AGENT_CONTRIBUTIONS
            })
          )
        return true
      case 'plugin-tool-cancel':
        this.calls.get(`${owner}\0${request.requestId}`)?.abort()
        return true
      case 'plugin-tool-request': {
        const key = `${owner}\0${request.requestId}`
        const controller = new AbortController()
        this.calls.set(key, controller)
        void this.run(request, controller.signal)
          .then(
            (text) =>
              reply({ type: 'plugin-tool-response', requestId: request.requestId, ok: true, text }),
            (error: unknown) =>
              reply({
                type: 'plugin-tool-response',
                requestId: request.requestId,
                ok: false,
                error: (error instanceof Error ? error.message : '插件工具失败').slice(0, 2000)
              })
          )
          .finally(() => this.calls.delete(key))
        return true
      }
    }
  }

  /** A session worker exited; its in-flight tool calls are abandoned. */
  cancelOwner(owner: string): void {
    for (const [key, controller] of this.calls) if (key.startsWith(`${owner}\0`)) controller.abort()
  }

  private async run(
    request: { pluginId: string; name: string; input: unknown; cwd: string },
    signal: AbortSignal
  ): Promise<string> {
    const project = this.dependencies.foregroundProject()
    const canonicalize = this.dependencies.canonicalize ?? realpath
    const [cwd, open] = await Promise.all([
      canonicalize(request.cwd).catch(() => null),
      project ? canonicalize(project).catch(() => null) : null
    ])
    if (!cwd || !open || cwd !== open) throw new Error('插件工具只在当前窗口打开的项目中可用')
    return this.dependencies.runTool(request.pluginId, request.name, request.input, signal)
  }
}
