import { z } from 'zod'

/**
 * Engines that do not own a login ask the desktop for one: the ChatGPT accounts Pi holds, and a
 * short-lived access token for one of them. The desktop asks the user before an engine uses an
 * account for the first time; refresh tokens never leave Pi.
 */
export const credentialRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      type: z.literal('credential:request'),
      requestId: z.string().min(1).max(128),
      kind: z.literal('chatgpt-accounts')
    })
    .strict(),
  z
    .object({
      type: z.literal('credential:request'),
      requestId: z.string().min(1).max(128),
      kind: z.literal('chatgpt-token'),
      accountId: z.string().min(1).max(128),
      /** `refresh`: the engine was told its token is no longer valid. */
      reason: z.enum(['start', 'refresh'])
    })
    .strict()
])
export type CredentialRequest = z.infer<typeof credentialRequestSchema>

export type SharedChatgptAccount = {
  /** Pi's provider id, e.g. `openai-codex` or `openai-codex-<suffix>`. */
  id: string
  email?: string
  plan?: string
  /** The user already allowed this engine to use the account. */
  granted: boolean
}

export type ChatgptAccessToken = {
  accessToken: string
  chatgptAccountId: string
  planType: string | null
}

export const credentialResponseSchema = z.union([
  z
    .object({
      type: z.literal('credential:response'),
      requestId: z.string(),
      ok: z.literal(true),
      data: z.unknown()
    })
    .strict(),
  z
    .object({
      type: z.literal('credential:response'),
      requestId: z.string(),
      ok: z.literal(false),
      error: z.string()
    })
    .strict()
])
export type CredentialResponse = z.infer<typeof credentialResponseSchema>

/** Asking the user whether an engine may use an account; shown as a desktop dialog. */
export type CredentialGrantPrompt = {
  id: string
  runtimeId: string
  runtimeLabel: string
  accountId: string
  email?: string
}
export type CredentialGrantDecision = 'once' | 'always' | 'deny'

/** Allowed (runtime, account) pairs, keyed by the account's email when known. */
export type CredentialGrant = { runtimeId: string; account: string }
