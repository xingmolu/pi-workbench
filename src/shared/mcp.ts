import { z } from 'zod'

export const mcpIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const secretMap = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/), z.string().max(8192))
  .refine((value) => Object.keys(value).length <= 32)
export const mcpServerSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => !/[\r\n\0]/.test(value))
      .optional(),
    args: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes('\0'))
      )
      .max(64)
      .optional(),
    env: secretMap.optional(),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value)
          return (
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search &&
            (url.protocol === 'https:' ||
              (url.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
          )
        } catch {
          return false
        }
      }, '仅支持 HTTPS 或本机 HTTP，凭证请使用请求头')
      .optional(),
    headers: secretMap
      .refine((value) => Object.values(value).every((item) => !/[\r\n\0]/.test(item)))
      .optional(),
    disabled: z.boolean().optional(),
    timeout: z.number().int().min(1000).max(60000).optional()
  })
  .strict()
  .refine((value) => Boolean(value.command) !== Boolean(value.url), '选择命令或 URL')
  .refine((value) => (value.command ? !value.headers : !value.args && !value.env), '传输配置不匹配')
export type McpServer = z.infer<typeof mcpServerSchema>
export const mcpSummarySchema = z
  .object({
    id: mcpIdSchema,
    transport: z.enum(['stdio', 'http', 'unsupported']),
    command: z.string().max(2048).optional(),
    args: z.array(z.string().max(8192)).max(64).optional(),
    url: z.string().max(2048).optional(),
    timeout: z.number().optional(),
    envKeys: z.array(z.string()).max(32),
    headerKeys: z.array(z.string()).max(32),
    enabled: z.boolean(),
    editable: z.boolean(),
    status: z.enum([
      'disabled',
      'untrusted',
      'unsupported',
      'disconnected',
      'connecting',
      'connected',
      'error'
    ]),
    toolCount: z.number().int().min(0).max(128),
    message: z.string().max(240).optional()
  })
  .strict()
export const mcpSnapshotSchema = z
  .object({
    revision: z.string(),
    writable: z.boolean(),
    message: z.string().max(240).optional(),
    servers: z.array(mcpSummarySchema).max(16),
    saved: z.boolean().optional(),
    applied: z.boolean().optional()
  })
  .strict()
export type McpSnapshot = z.infer<typeof mcpSnapshotSchema>
export type McpSummary = z.infer<typeof mcpSummarySchema>
export const mcpListSchema = z.object({ type: z.literal('mcp:list') }).strict()
export const mcpShutdownSchema = z.object({ type: z.literal('mcp:shutdown') }).strict()
const identity = { sessionId: z.string().nullable(), generation: z.number().int().nonnegative() }
export const mcpSaveSchema = z
  .object({
    type: z.literal('mcp:save'),
    ...identity,
    revision: z.string(),
    id: mcpIdSchema,
    server: mcpServerSchema,
    enabled: z.boolean(),
    create: z.boolean()
  })
  .strict()
export const mcpToggleSchema = z
  .object({
    type: z.literal('mcp:toggle'),
    ...identity,
    revision: z.string(),
    id: mcpIdSchema,
    enabled: z.boolean()
  })
  .strict()
export const mcpReloadSchema = z.object({ type: z.literal('mcp:reload'), ...identity }).strict()
export type McpCommand =
  | z.infer<typeof mcpListSchema>
  | z.infer<typeof mcpShutdownSchema>
  | z.infer<typeof mcpSaveSchema>
  | z.infer<typeof mcpToggleSchema>
  | z.infer<typeof mcpReloadSchema>
