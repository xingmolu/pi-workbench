import { z } from 'zod'

/**
 * One-shot generations that are not part of a conversation: session titles, commit messages,
 * pull request text, and whatever a plugin asks for with `ai.complete`. They run on Pi's
 * models in its configuration host, preferring small fast ones over the session's own model.
 */
export const UTILITY_LIMITS = {
  system: 8_000,
  prompt: 100_000,
  maxTokens: 2_000,
  /** Longest text handed back; a utility answer is a line or a paragraph, not a document. */
  result: 20_000
} as const

/** Settings lists Pi's models to choose the one for these generations. */
export const UTILITY_MODELS_CHANNEL = 'pi:utility-models'
export type UtilityModelOption = { providerId: string; modelId: string; name: string }

/** Each attempt; a slow model falls through to the next candidate. */
export const UTILITY_ATTEMPT_TIMEOUT_MS = 30_000
/** Defaults tried after the user's choice and before the session's model. */
const MAX_DEFAULT_CANDIDATES = 2

export const utilityModelRefSchema = z
  .object({ providerId: z.string().min(1).max(128), modelId: z.string().min(1).max(200) })
  .strict()
export type UtilityModelRef = z.infer<typeof utilityModelRefSchema>

/** Main-only: never routed from a renderer. */
export const utilityCompleteCommandSchema = z
  .object({
    type: z.literal('utility:complete'),
    system: z.string().max(UTILITY_LIMITS.system).optional(),
    prompt: z.string().min(1).max(UTILITY_LIMITS.prompt),
    maxTokens: z.number().int().min(16).max(UTILITY_LIMITS.maxTokens),
    /** The user's choice in Settings, tried first. */
    preferred: z.array(utilityModelRefSchema).max(4),
    /** The model of the session the request is about, tried last. */
    fallback: utilityModelRefSchema.optional()
  })
  .strict()
export type UtilityCompleteCommand = z.infer<typeof utilityCompleteCommandSchema>

export const utilityCompletionSchema = z
  .object({
    text: z.string().min(1).max(UTILITY_LIMITS.result),
    providerId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(200)
  })
  .strict()
export type UtilityCompletion = z.infer<typeof utilityCompletionSchema>

/** Not chat models, or not ones that answer a short text prompt quickly. */
const UNSUITABLE = /image|audio|tts|transcribe|embed|realtime|search|reason|thinking|-pro\b/i

/**
 * Small, fast models matched on the model id, in order. The first enabled provider that has a
 * match wins each slot, so the list works with subscriptions, API keys and gateways alike.
 */
export const UTILITY_MODEL_PATTERNS: readonly RegExp[] = [
  /haiku/i,
  /\bgpt-[\d.]+(?:-codex)?-mini\b/i,
  /gemini-[\d.]+-flash/i,
  /deepseek-(?:chat|v[\d.]+)/i,
  /qwen[\w.-]*-(?:flash|turbo)/i,
  /glm-[\d.]+-(?:air|flash)/i,
  /\bgpt-[\d.]+-nano\b/i
]

function sameRef(left: UtilityModelRef, right: UtilityModelRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/**
 * Which models to try, in order: the user's choice, then up to two small defaults, then the
 * session's model. Only models that are available now are returned.
 */
export function utilityModelCandidates(
  available: readonly { provider: string; id: string }[],
  options: { preferred: readonly UtilityModelRef[]; fallback?: UtilityModelRef }
): UtilityModelRef[] {
  const refs = available.map((model) => ({ providerId: model.provider, modelId: model.id }))
  const isAvailable = (ref: UtilityModelRef): boolean => refs.some((item) => sameRef(item, ref))
  const candidates: UtilityModelRef[] = []
  const add = (ref: UtilityModelRef): void => {
    if (isAvailable(ref) && !candidates.some((item) => sameRef(item, ref))) candidates.push(ref)
  }
  for (const ref of options.preferred) add(ref)
  let defaults = 0
  for (const pattern of UTILITY_MODEL_PATTERNS) {
    if (defaults >= MAX_DEFAULT_CANDIDATES) break
    const match = refs.find((ref) => pattern.test(ref.modelId) && !UNSUITABLE.test(ref.modelId))
    if (match && !candidates.some((item) => sameRef(item, match))) {
      candidates.push(match)
      defaults++
    }
  }
  if (options.fallback) add(options.fallback)
  return candidates
}

/** `provider/model` as Settings stores the user's choice; null when unset or malformed. */
export function parseUtilityModel(value: string | null | undefined): UtilityModelRef | null {
  if (!value) return null
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  const parsed = utilityModelRefSchema.safeParse({
    providerId: value.slice(0, slash),
    modelId: value.slice(slash + 1)
  })
  return parsed.success ? parsed.data : null
}

/**
 * A generated one-line label (a session title): first non-empty line, without the quotes,
 * markdown and trailing punctuation small models like to add, at most `limit` characters.
 */
export function cleanGeneratedLine(text: string, limit = 60): string {
  const line =
    text
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ''
  const cleaned = line
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
    .replace(/^["'“”‘’「『`\s]+/u, '')
    .replace(/["'“”‘’」』`。.!！\s]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  const characters = [...cleaned]
  return characters.length > limit ? characters.slice(0, limit).join('').trim() : cleaned
}
