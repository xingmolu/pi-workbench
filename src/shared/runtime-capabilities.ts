import { z } from 'zod'
import { sessionTaskResponseSchema } from './session-task-capability'

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
const projectMutationResponseSchema = z
  .object({
    type: z.literal('project-mutation-response'),
    requestId: z.string().min(1),
    ok: z.boolean()
  })
  .strict()

/**
 * Responses delivered on the Agent Host runtime-capability channel.
 * The historical export name is retained so the large host entrypoint does not
 * need a transport-only edit while capabilities become extensible.
 */
export const mutationResponseSchema = z.union([
  projectMutationResponseSchema,
  sessionTaskResponseSchema
])
export type MutationCapability = z.infer<typeof mutationCapabilitySchema>
export type MutationResponse = z.infer<typeof mutationResponseSchema>
