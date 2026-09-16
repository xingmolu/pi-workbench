import { z } from 'zod'

const controlCharacters = /[\p{Cc}\p{Zl}\p{Zp}]/u
const boundedText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((value) => !controlCharacters.test(value))
    .transform((value) => value.trim())
    .refine((value) => [...value].length >= 1 && [...value].length <= max)

export const customEndpointApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages'
])
export type CustomEndpointApi = z.infer<typeof customEndpointApiSchema>

export const customEndpointUrlSchema = z
  .string()
  .max(8192)
  .refine((value) => {
    if (controlCharacters.test(value) || value !== value.trim() || value.includes('\\'))
      return false
    try {
      const url = new URL(value)
      const authority = value.split('/')[2]
      if (
        !authority ||
        url.username ||
        url.password ||
        authority.includes('@') ||
        value.includes('?') ||
        value.includes('#')
      )
        return false
      if (url.protocol === 'https:') return /^https:\/\//i.test(value)
      // Check the explicit authority as well: URL canonicalizes integer/hex/short IPv4 hosts.
      return (
        url.protocol === 'http:' &&
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(value) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    } catch {
      return false
    }
  }, '端点地址必须为 HTTPS，或显式的本机 HTTP 地址')

const keySchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .refine(
    (value) => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 16 * 1024
  )
export const customEndpointMetadataInputSchema = z
  .object({
    label: boundedText(80),
    api: customEndpointApiSchema,
    baseUrl: customEndpointUrlSchema,
    modelIds: z
      .array(boundedText(200))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
  })
  .strict()
export const customEndpointSchema = customEndpointMetadataInputSchema.extend({
  key: keySchema.optional()
})
export const createCustomEndpointSchema = customEndpointSchema.extend({ key: keySchema })
export type CustomEndpointInput = z.infer<typeof customEndpointSchema>
export type CustomEndpointMetadataInput = z.infer<typeof customEndpointMetadataInputSchema>

export type CustomEndpointMetadata = {
  id: string
  label: string
  api: CustomEndpointApi | null
  baseUrl: string | null
  modelIds: string[]
  editable: boolean
  unsupportedReason: '此配置包含不支持的字段或地址，请在 Pi 配置文件中管理' | null
}

export type CustomEndpointConfigSnapshot = { revision: string; endpoints: CustomEndpointMetadata[] }

export type CustomEndpointSaveRequest = {
  id?: string
  expectedRevision: string
  endpoint: CustomEndpointInput
}
export type CustomEndpointSaveResult = {
  ok: boolean
  providerId: string | null
  metadata: 'unchanged' | 'saved'
  credential: 'unchanged' | 'saved' | 'unknown'
  runtime: 'synchronized' | 'failed'
  selection: 'unchanged' | 'rebound' | 'model-missing' | 'model-config-changed'
  message: string
  snapshot: CustomEndpointConfigSnapshot | null
}

export const customEndpointContextSchema = z
  .object({
    projectPath: z.string().nullable(),
    sessionId: z.string().nullable(),
    generation: z.number().int().nonnegative()
  })
  .strict()
export type CustomEndpointContext = z.infer<typeof customEndpointContextSchema>
export const customEndpointSaveRequestSchema = z
  .object({
    id: z
      .string()
      .regex(/^custom-[a-z0-9][a-z0-9-]{0,99}$/)
      .optional(),
    expectedRevision: z.string().max(128),
    endpoint: customEndpointSchema
  })
  .strict()
export const customEndpointMetadataSchema: z.ZodType<CustomEndpointMetadata> = z
  .object({
    id: z.string(),
    label: z.string(),
    api: customEndpointApiSchema.nullable(),
    baseUrl: z.string().nullable(),
    modelIds: z.array(z.string()),
    editable: z.boolean(),
    unsupportedReason: z.literal('此配置包含不支持的字段或地址，请在 Pi 配置文件中管理').nullable()
  })
  .strict()
export const customEndpointConfigSnapshotSchema = z
  .object({
    revision: z.string(),
    endpoints: z.array(customEndpointMetadataSchema)
  })
  .strict()
export const customEndpointSaveResultSchema: z.ZodType<CustomEndpointSaveResult> = z
  .object({
    ok: z.boolean(),
    providerId: z.string().nullable(),
    metadata: z.enum(['unchanged', 'saved']),
    credential: z.enum(['unchanged', 'saved', 'unknown']),
    runtime: z.enum(['synchronized', 'failed']),
    selection: z.enum(['unchanged', 'rebound', 'model-missing', 'model-config-changed']),
    message: z.string(),
    snapshot: customEndpointConfigSnapshotSchema.nullable()
  })
  .strict()

/** IDs are host-generated identities, independent of the editable display label. */
export function isCustomEndpointId(id: string): boolean {
  return /^custom-[a-z0-9][a-z0-9-]{0,99}$/.test(id)
}
