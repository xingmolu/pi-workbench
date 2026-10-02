import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { PluginAgentTool } from '../shared/plugin-agent'
import type { ToolGate } from './tool-gate'
import { t } from '../shared/i18n'

export type PluginToolMcpBridgeOptions = {
  tools: readonly PluginAgentTool[]
  gate: Pick<ToolGate, 'before' | 'after'>
  run(tool: PluginAgentTool, input: unknown, signal: AbortSignal): Promise<string>
  context(): { sessionId: string | null; cwd: string }
}

/**
 * Exposes plugin agent tools to runtimes that take tools over MCP (`toolDelivery: 'mcp'`).
 * The runtime connects to this server over any MCP transport; each call passes the same
 * ToolGate as a natively registered tool before the plugin runs it.
 */
export function createPluginToolMcpServer(options: PluginToolMcpBridgeOptions): Server {
  const server = new Server(
    { name: 'pi-desktop-plugins', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  const byName = new Map(options.tools.map((tool) => [tool.toolName, tool]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.toolName,
      title: `${tool.pluginName} · ${tool.title}`,
      description: tool.description,
      inputSchema: { ...tool.parameters, type: 'object' as const },
      annotations: { readOnlyHint: tool.readOnly }
    }))
  }))

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const tool = byName.get(request.params.name)
      if (!tool) return errorResult(t('插件工具不存在'))
      const { sessionId, cwd } = options.context()
      const toolCallId = randomUUID()
      const input = request.params.arguments ?? {}
      const decision = await options.gate.before({
        sessionId,
        toolCallId,
        tool: tool.toolName,
        category: 'plugin',
        input,
        cwd,
        readOnly: tool.readOnly
      })
      if (decision.decision === 'deny') return errorResult(decision.reason)
      let ok = false
      try {
        const text = await options.run(tool, input, extra.signal)
        ok = true
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : t('插件工具失败'))
      } finally {
        options.gate.after({ sessionId, toolCallId, category: 'plugin', ok })
      }
    }
  )
  return server
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
