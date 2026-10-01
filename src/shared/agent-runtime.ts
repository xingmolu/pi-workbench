import { z } from 'zod'
import type { HostCommand } from './contracts'

export const RUNTIME_PROTOCOL_VERSION = 1 as const
export const RUNTIME_CATALOG_CHANNEL = 'pi:runtimes'
export const runtimeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/)
export type AgentRuntimeProviderId = string

export const RUNTIME_FEATURES = [
  'session-resume',
  'session-fork',
  'session-rename',
  'session-edit',
  'session-search',
  'project-catalog',
  'model-selection',
  'thinking',
  'images',
  'auth-login',
  'account-aliases',
  'account-quota',
  'custom-endpoints',
  'mcp',
  'skills',
  'attachments',
  'checkpoints',
  'message-feedback',
  'permission-rules',
  'queue',
  'host-browser',
  'host-computer-use'
] as const
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number]

/** Public plugin metadata. No SDK types, executable paths or credentials cross this seam. */
export const agentRuntimeManifestSchema = z
  .object({
    apiVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    id: runtimeIdSchema,
    label: z.string().min(1).max(100),
    engine: z.string().min(1).max(200),
    features: z.array(z.enum(RUNTIME_FEATURES)).max(RUNTIME_FEATURES.length),
    authentication: z.array(z.enum(['api_key', 'browser', 'device_code', 'external'])).max(4),
    subagents: z.enum(['native', 'desktop', 'none']),
    toolDelivery: z.enum(['native', 'mcp', 'none']),
    skills: z.enum(['native', 'prompt', 'none']),
    /** Legacy adapters can retain existing config/history while migration is designed separately. */
    storage: z.enum(['desktop', 'legacy']),
    /**
     * Subscription logins this plugin can perform. The plugin owns the mechanics (official
     * CLI or OAuth flow); the host lists the resulting accounts by email.
     */
    accountProviders: z
      .array(
        z
          .object({
            platform: z.enum(['chatgpt', 'claude']),
            label: z.string().min(1).max(60),
            login: z
              .array(z.enum(['browser', 'device_code']))
              .min(1)
              .max(2)
          })
          .strict()
      )
      .max(8)
      .optional(),
    /** Credentials a chat on this engine can be bound to. */
    credentials: z
      .object({
        accounts: z.array(z.enum(['chatgpt', 'claude'])).max(8),
        apis: z
          .array(z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']))
          .max(8)
      })
      .strict()
      .optional()
  })
  .strict()
export type AgentRuntimeManifest = z.infer<typeof agentRuntimeManifestSchema>
export const agentRuntimeCatalogSchema = z.array(agentRuntimeManifestSchema).max(64)

/** Exhaustive classification: adding a desktop command requires deciding its runtime capability. */
const COMMAND_FEATURE: Record<HostCommand['type'], RuntimeFeature | null> = {
  bootstrap: null,
  'state:get': null,
  'runtime:refresh': null,
  'runtime:shutdown': null,
  'project:open': null,
  'project:navigate': null,
  'session:new': null,
  'prompt:send': null,
  'prompt:abort': null,
  'permission:set': null,
  'permission:respond': null,
  'session-task:cancel': null,
  'subagent:inspect': null,
  'session:open': 'session-resume',
  'session:fork': 'session-fork',
  'session:rename': 'session-rename',
  'session:edit:prepare': 'session-edit',
  'session:edit:cancel': 'session-edit',
  'session:edit:send': 'session-edit',
  'session:edit:query': 'session-edit',
  'session:search': 'session-search',
  'project:search': 'session-search',
  'project:catalog': 'project-catalog',
  'model:set': 'model-selection',
  'thinking:set': 'thinking',
  'account:login': 'auth-login',
  'account:api-key:set': null,
  'account:login:respond': 'auth-login',
  'account:alias:add': 'account-aliases',
  'account:add': 'auth-login',
  'account:remove': 'auth-login',
  'account:quota': 'account-quota',
  'endpoint:list': 'custom-endpoints',
  'endpoint:save': 'custom-endpoints',
  'endpoint:discover': 'custom-endpoints',
  'mcp:list': 'mcp',
  'mcp:save': 'mcp',
  'mcp:toggle': 'mcp',
  'mcp:reload': 'mcp',
  'mcp:login': 'mcp',
  'mcp:logout': 'mcp',
  'mcp:shutdown': 'mcp',
  'skills:list': 'skills',
  'skills:detail': 'skills',
  'attachment:prompt': 'attachments',
  'attachment:query': 'attachments',
  'checkpoint:plan': 'checkpoints',
  'checkpoint:restore': 'checkpoints',
  'message:feedback': 'message-feedback',
  'permission:rules:set': 'permission-rules',
  'queue:clear': 'queue',
  'browser:e2e': 'host-browser'
}

export function runtimeSupportsCommand(
  manifest: AgentRuntimeManifest,
  command: HostCommand
): boolean {
  const feature = COMMAND_FEATURE[command.type]
  if (feature && !manifest.features.includes(feature)) return false
  if (
    command.type === 'project:navigate' &&
    command.sessionPath &&
    !manifest.features.includes('session-resume')
  )
    return false
  if (
    command.type === 'session:new' &&
    'providerId' in command &&
    !manifest.features.includes('model-selection')
  )
    return false
  if (
    command.type === 'prompt:send' &&
    command.images?.length &&
    !manifest.features.includes('images')
  )
    return false
  if (command.type === 'account:login' && !manifest.authentication.includes(command.method))
    return false
  if (command.type === 'account:api-key:set' && !manifest.authentication.includes('api_key'))
    return false
  if (command.type === 'session-task:cancel' && manifest.subagents === 'none') return false
  if (command.type === 'subagent:inspect' && manifest.subagents !== 'native') return false
  return true
}
