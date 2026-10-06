import { z } from 'zod'
import { customEndpointUrlSchema } from './custom-endpoints'

/** One gateway address and key, checked for the protocols each engine speaks. */
export const GATEWAY_PROBE_CHANNEL = 'pi:gateway-probe'

export const gatewayProbeInputSchema = z
  .object({
    baseUrl: customEndpointUrlSchema,
    key: z
      .string()
      .min(1)
      .max(16 * 1024)
      .refine((value) => value.trim().length > 0)
  })
  .strict()
export type GatewayProbeInput = z.infer<typeof gatewayProbeInputSchema>

/** How Claude Code sends the key: `x-api-key` (Anthropic's own) or `Authorization: Bearer`. */
export type AnthropicAuth = 'x-api-key' | 'bearer'

export type GatewayProbe = {
  /** OpenAI-compatible base (ending in /v1) and which of its endpoints answer. */
  openai: { baseUrl: string; chat: boolean; responses: boolean } | null
  /** Anthropic-compatible base, as Claude Code takes it (without /v1). */
  anthropic: { baseUrl: string; auth: AnthropicAuth } | null
  modelIds: string[]
  truncated: boolean
}

/** Which engines a probed gateway can serve. Codex speaks only the Responses API. */
export function gatewayEngines(probe: GatewayProbe): {
  pi: boolean
  claude: boolean
  codex: boolean
} {
  return {
    pi: Boolean(probe.openai || probe.anthropic),
    claude: Boolean(probe.anthropic),
    codex: Boolean(probe.openai?.responses)
  }
}
