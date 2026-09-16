import { z } from 'zod'

const identity = {
  requestId: z.string().min(1),
  sessionId: z.string(),
  generation: z.number().int().nonnegative()
}
export const mutationCapabilitySchema = z.discriminatedUnion('action', [
  z
    .object({ type: z.literal('project-mutation'), action: z.literal('acquire'), ...identity })
    .strict(),
  z
    .object({
      type: z.literal('project-mutation'),
      action: z.literal('release'),
      requestId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal('project-mutation'),
      action: z.literal('cancel'),
      requestId: z.string().min(1)
    })
    .strict()
])
export const mutationResponseSchema = z
  .object({
    type: z.literal('project-mutation-response'),
    requestId: z.string().min(1),
    ok: z.boolean()
  })
  .strict()
export type MutationCapability = z.infer<typeof mutationCapabilitySchema>
export type MutationResponse = z.infer<typeof mutationResponseSchema>
