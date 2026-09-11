import { z } from 'zod'

export const MESSAGE_FEEDBACK_TYPE = 'pi-desktop:message-feedback'
export const messageFeedbackDataSchema = z
  .object({
    entryId: z.string().min(1),
    value: z.enum(['up', 'down']).nullable()
  })
  .strict()
export const messageFeedbackCommandSchema = messageFeedbackDataSchema
  .extend({
    type: z.literal('message:feedback'),
    sessionId: z.string().min(1),
    generation: z.number().int().nonnegative()
  })
  .strict()
export type MessageFeedbackValue = z.infer<typeof messageFeedbackDataSchema>['value']
export type MessageFeedbackCommand = z.infer<typeof messageFeedbackCommandSchema>
