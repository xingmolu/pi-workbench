import { z } from 'zod'
import { axHitTargetSchema } from './desktop-control'

export const COMPUTER_USE_LIMITS = {
  maxStateIdLength: 80,
  maxQueryLength: 200,
  maxResults: 20,
  maxTextLength: 200
} as const

export const computerUseStateIdSchema = z.string().min(1).max(COMPUTER_USE_LIMITS.maxStateIdLength)
export const computerUseRefSchema = z.string().regex(/^@e[1-9]\d*$/)
export const computerUseModeSchema = z.enum(['semantic', 'visual', 'fused'])

export const computerUseElementSchema = axHitTargetSchema
  .extend({
    ref: computerUseRefSchema,
    parentRef: computerUseRefSchema.optional(),
    description: z.string().max(80)
  })
  .strict()
export type ComputerUseElement = z.infer<typeof computerUseElementSchema>

export const computerUseObservationSchema = z
  .object({
    kind: z.literal('observation'),
    stateId: computerUseStateIdSchema,
    mode: z.literal('semantic'),
    app: z.string().max(80),
    bundleId: z.string().max(80),
    truncated: z.boolean(),
    elements: z.array(computerUseElementSchema).max(80)
  })
  .strict()
export type ComputerUseObservation = z.infer<typeof computerUseObservationSchema>

export const computerUseOperationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('observe'),
      mode: computerUseModeSchema.optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      stateId: computerUseStateIdSchema,
      query: z.string().min(1).max(COMPUTER_USE_LIMITS.maxQueryLength)
    })
    .strict(),
  z
    .object({
      action: z.literal('inspect'),
      stateId: computerUseStateIdSchema,
      ref: computerUseRefSchema
    })
    .strict(),
  z
    .object({
      action: z.literal('act'),
      stateId: computerUseStateIdSchema,
      ref: computerUseRefSchema,
      intent: z.enum(['press', 'move', 'type']),
      text: z.string().min(1).max(COMPUTER_USE_LIMITS.maxTextLength).optional()
    })
    .strict()
])
export type ComputerUseOperation = z.infer<typeof computerUseOperationSchema>

export const computerUseResultSchema = z.discriminatedUnion('kind', [
  computerUseObservationSchema,
  z
    .object({
      kind: z.literal('search'),
      stateId: computerUseStateIdSchema,
      query: z.string(),
      matches: z.array(computerUseElementSchema).max(COMPUTER_USE_LIMITS.maxResults)
    })
    .strict(),
  z
    .object({
      kind: z.literal('inspect'),
      stateId: computerUseStateIdSchema,
      element: computerUseElementSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('action'),
      previousStateId: computerUseStateIdSchema,
      ref: computerUseRefSchema,
      action: z.enum(['press', 'move', 'type']),
      delivered: z.literal(true),
      changed: z.boolean(),
      observation: computerUseObservationSchema,
      message: z.string().max(400)
    })
    .strict()
])
export type ComputerUseResult = z.infer<typeof computerUseResultSchema>
