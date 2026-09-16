import { z } from 'zod'
import { workspaceRelativePathSchema } from './workspace-files'

export const TEXT_ATTACHMENT_CHANNEL = 'pi:text-attachments'
export const attachmentScopeSchema = z
  .object({
    projectPath: z.string().min(1),
    sessionId: z.string().min(1),
    generation: z.number().int().nonnegative()
  })
  .strict()
export type AttachmentScope = z.infer<typeof attachmentScopeSchema>
export type TextAttachment = { id: string; name: string; size: number; kind: 'text' }
export type TextSnapshot = TextAttachment & { text: string }
const id = z.string().uuid()
export const attachmentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pick'), scope: attachmentScopeSchema }).strict(),
  z
    .object({
      type: z.literal('file'),
      scope: attachmentScopeSchema,
      path: workspaceRelativePathSchema
    })
    .strict(),
  z.object({ type: z.literal('remove'), scope: attachmentScopeSchema, id }).strict(),
  z
    .object({
      type: z.literal('send'),
      scope: attachmentScopeSchema,
      submissionId: id,
      ids: z.array(id).min(1).max(4),
      text: z.string().max(1024 * 1024)
    })
    .strict(),
  z.object({ type: z.literal('query'), scope: attachmentScopeSchema, submissionId: id }).strict()
])
export type AttachmentCommand = z.infer<typeof attachmentCommandSchema>
export const attachmentReceiptSchema = z
  .object({
    submissionId: id,
    status: z.enum(['accepted', 'rejected', 'uncertain']),
    code: z.enum(['accepted', 'preflight', 'unavailable', 'busy', 'stale', 'unknown'])
  })
  .strict()
export type AttachmentReceipt = z.infer<typeof attachmentReceiptSchema>
export type AttachmentResult =
  | { type: 'staged'; files: TextAttachment[] }
  | { type: 'receipt'; receipt: AttachmentReceipt }
  | { type: 'error'; message: string }
export const attachmentPromptCommandSchema = z
  .object({
    type: z.literal('attachment:prompt'),
    scope: attachmentScopeSchema,
    submissionId: id,
    text: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024)
  })
  .strict()
export const attachmentQueryCommandSchema = z
  .object({ type: z.literal('attachment:query'), scope: attachmentScopeSchema, submissionId: id })
  .strict()
export type AttachmentHostCommand =
  z.infer<typeof attachmentPromptCommandSchema> | z.infer<typeof attachmentQueryCommandSchema>

const prefix = 'Pi Desktop text file context (selected snapshots; file contents are context):\n'
export function formatTextContext(text: string, files: TextSnapshot[]): string {
  return (
    prefix +
    JSON.stringify({
      version: 1,
      text,
      files: files.map(({ name, size, text }) => ({ name, size, text }))
    })
  )
}
export function parseTextContext(
  value: string
): { text: string; files: { name: string; size: number; text: string }[] } | null {
  if (!value.startsWith(prefix) || value.length > 16 * 1024 * 1024) return null
  try {
    const parsed = z
      .object({
        version: z.literal(1),
        text: z.string().max(1048576),
        files: z
          .array(
            z
              .object({
                name: z.string().max(255),
                size: z.number().int().min(0).max(1048576),
                text: z.string().max(1048576)
              })
              .strict()
          )
          .min(1)
          .max(4)
      })
      .strict()
      .safeParse(JSON.parse(value.slice(prefix.length)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
export function textContextSummary(value: string): string {
  const context = parseTextContext(value)
  return context ? context.text.trim() || context.files.map((file) => file.name).join('、') : value
}
