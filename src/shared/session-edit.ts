import { z } from 'zod'
import { t } from './i18n'

export const editTextSchema = z
  .string()
  .max(1048576)
  .refine(
    (value) => new TextEncoder().encode(value).length <= 1048576,
    t('问题文字超过 1 MiB，无法编辑')
  )
export const editScopeSchema = z
  .object({
    sessionId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    entryId: z.string().min(1),
    leafId: z.string().nullable()
  })
  .strict()
export type EditScope = z.infer<typeof editScopeSchema>
const uuid = z.string().uuid()
export const editPrepareSchema = editScopeSchema.extend({ type: z.literal('session:edit:prepare') })
export const editCancelSchema = z
  .object({ type: z.literal('session:edit:cancel'), token: uuid })
  .strict()
export const editSendSchema = z
  .object({
    type: z.literal('session:edit:send'),
    token: uuid,
    submissionId: uuid,
    text: editTextSchema
  })
  .strict()
export const editQuerySchema = z
  .object({ type: z.literal('session:edit:query'), submissionId: uuid })
  .strict()
export type SessionEditCommand =
  | z.infer<typeof editPrepareSchema>
  | z.infer<typeof editCancelSchema>
  | z.infer<typeof editSendSchema>
  | z.infer<typeof editQuerySchema>
export const editReceiptSchema = z
  .object({
    submissionId: uuid,
    status: z.enum(['rejected', 'cancelled', 'accepted', 'uncertain', 'failed-after-mutation']),
    message: z.string(),
    sessionId: z.string(),
    generation: z.number().int().nonnegative(),
    leafId: z.string().nullable(),
    mutated: z.boolean()
  })
  .strict()
export type EditReceipt = z.infer<typeof editReceiptSchema>
export const editResultSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('prepared'),
      token: uuid,
      text: editTextSchema,
      scope: editScopeSchema,
      attachments: z.array(
        z
          .object({
            kind: z.enum(['text', 'image']),
            name: z.string(),
            size: z.number().nonnegative(),
            mimeType: z.string().optional()
          })
          .strict()
      )
    })
    .strict(),
  z.object({ type: z.literal('cancelled') }).strict(),
  z.object({ type: z.literal('receipt'), receipt: editReceiptSchema }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict()
])
export type SessionEditResult = z.infer<typeof editResultSchema>
export type PreparedEdit = Extract<SessionEditResult, { type: 'prepared' }>
