import { z } from 'zod'
import { mcpIdSchema, mcpServerSchema } from './mcp'

/**
 * Agent Host ⇄ Main messages that deliver plugin contributions to an agent session.
 * Main owns which plugins are enabled and granted; the Agent Host asks when it builds a
 * session runtime and routes every plugin tool call back to Main.
 */

/** Model-facing tool names: `<plugin id slug>__<tool name>`, within common provider limits. */
export function pluginToolName(pluginId: string, name: string): string | null {
  const full = `${pluginId.replace(/[^a-z0-9]/g, '_')}__${name.replace(/[^a-z0-9_]/g, '_')}`
  return full.length <= 64 ? full : null
}

/** MCP server ids for plugin servers stay distinct from the user's own configuration. */
export function pluginMcpServerId(pluginId: string, id: string): string | null {
  const full = `${pluginId.replace(/[^a-zA-Z0-9]/g, '_')}_${id}`
  return mcpIdSchema.safeParse(full).success ? full : null
}

export const pluginAgentToolSchema = z
  .object({
    pluginId: z.string().min(1).max(256),
    pluginName: z.string().min(1).max(256),
    name: z.string().min(1).max(64),
    toolName: z.string().regex(/^[a-z0-9_]{1,64}$/),
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(2000),
    parameters: z.record(z.string(), z.unknown()),
    readOnly: z.boolean()
  })
  .strict()
export type PluginAgentTool = z.infer<typeof pluginAgentToolSchema>

export const pluginAgentContributionsSchema = z
  .object({
    tools: z.array(pluginAgentToolSchema).max(256),
    skillPaths: z.array(z.string().min(1).max(4096)).max(256),
    mcpServers: z.record(mcpIdSchema, mcpServerSchema)
  })
  .strict()
export type PluginAgentContributions = z.infer<typeof pluginAgentContributionsSchema>

export const EMPTY_PLUGIN_AGENT_CONTRIBUTIONS: PluginAgentContributions = {
  tools: [],
  skillPaths: [],
  mcpServers: {}
}

// Agent Host → Main
export const pluginAgentRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('plugin-agent-contributions-request'),
      requestId: z.string().min(1).max(128)
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin-tool-request'),
      requestId: z.string().min(1).max(128),
      sessionId: z.string().nullable(),
      pluginId: z.string().min(1).max(256),
      name: z.string().min(1).max(64),
      input: z.unknown(),
      cwd: z.string().min(1).max(4096)
    })
    .strict(),
  z
    .object({ type: z.literal('plugin-tool-cancel'), requestId: z.string().min(1).max(128) })
    .strict()
])
export type PluginAgentRequest = z.infer<typeof pluginAgentRequestSchema>

// Main → Agent Host
export const pluginAgentResponseSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('plugin-agent-contributions'),
      requestId: z.string().min(1).max(128),
      contributions: pluginAgentContributionsSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin-tool-response'),
      requestId: z.string().min(1).max(128),
      ok: z.boolean(),
      text: z.string().optional(),
      error: z.string().max(2000).optional()
    })
    .strict()
])
export type PluginAgentResponse = z.infer<typeof pluginAgentResponseSchema>
