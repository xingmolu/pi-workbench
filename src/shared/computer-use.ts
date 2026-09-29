import { z } from 'zod'
import { axHitTargetSchema, DESKTOP_CONTROL_AX_LIMITS } from './desktop-control'

export const COMPUTER_USE_LIMITS = {
  maxStateIdLength: 80,
  maxQueryLength: 200,
  maxResults: 20,
  maxTextLength: 200,
  maxImageDataLength: 10_000_000,
  maxImageDimension: 1600,
  maxVisualStateAgeMs: 30_000,
  maxAppNameLength: 80
} as const

/** Keys an agent may press in the target window; shortcuts that reach other apps are excluded. */
export const COMPUTER_USE_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End'
] as const
export const computerUseKeySchema = z.enum(COMPUTER_USE_KEYS)
export const computerUseIntentSchema = z.enum(['press', 'move', 'type', 'key'])

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

export const computerUseFrameRectSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000)
  })
  .strict()
export type ComputerUseFrameRect = z.infer<typeof computerUseFrameRectSchema>

export const computerUseVisualFrameSchema = z
  .object({
    /** display-crop: the window's area cut from its display, for windows the capturer omits. */
    scope: z.enum(['window', 'display-crop']),
    sourceId: z
      .string()
      .regex(/^(window|screen):\d+:\d+$/)
      .max(128),
    displayId: z.string().min(1).max(128),
    framePoints: computerUseFrameRectSchema,
    scaleFactor: z.number().finite().positive().max(8),
    capturedAt: z.number().finite().nonnegative(),
    image: z
      .object({
        mimeType: z.literal('image/png'),
        data: z
          .string()
          .min(1)
          .max(COMPUTER_USE_LIMITS.maxImageDataLength)
          .regex(/^[A-Za-z0-9+/=\s]+$/),
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000)
      })
      .strict()
  })
  .strict()
export type ComputerUseVisualFrame = z.infer<typeof computerUseVisualFrameSchema>

export const computerUseObservationSchema = z
  .object({
    kind: z.literal('observation'),
    stateId: computerUseStateIdSchema,
    mode: computerUseModeSchema,
    app: z.string().max(80),
    bundleId: z.string().max(80),
    truncated: z.boolean(),
    elements: z.array(computerUseElementSchema).max(DESKTOP_CONTROL_AX_LIMITS.maxNodes),
    visual: computerUseVisualFrameSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.mode === 'visual' || value.mode === 'fused') && !value.visual) {
      context.addIssue({
        code: 'custom',
        message: 'visual/fused observation requires a visual frame',
        path: ['visual']
      })
    }
    if (value.mode === 'semantic' && value.visual) {
      context.addIssue({
        code: 'custom',
        message: 'semantic observation must not carry a visual frame',
        path: ['visual']
      })
    }
  })
export type ComputerUseObservation = z.infer<typeof computerUseObservationSchema>

export const computerUseActionTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ref'),
      ref: computerUseRefSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('point'),
      x: z.number().int().nonnegative().max(10_000),
      y: z.number().int().nonnegative().max(10_000)
    })
    .strict()
])
export type ComputerUseActionTarget = z.infer<typeof computerUseActionTargetSchema>

export const computerUseOperationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('observe'),
      mode: computerUseModeSchema.optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('activate'),
      app: z.string().trim().min(1).max(COMPUTER_USE_LIMITS.maxAppNameLength),
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
      target: computerUseActionTargetSchema.optional(),
      intent: computerUseIntentSchema,
      text: z.string().min(1).max(COMPUTER_USE_LIMITS.maxTextLength).optional(),
      key: computerUseKeySchema.optional()
    })
    .strict()
])
export type ComputerUseOperation = z.infer<typeof computerUseOperationSchema>

export const computerUseResultSchema = z.union([
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
      target: computerUseActionTargetSchema.optional(),
      action: computerUseIntentSchema,
      delivered: z.literal(true),
      changed: z.boolean(),
      verification: z.enum(['semantic-change', 'visual-change', 'delivered-only']),
      observation: computerUseObservationSchema,
      message: z.string().max(400)
    })
    .strict()
])
export type ComputerUseResult = z.infer<typeof computerUseResultSchema>

export function computerUseImagePointToScreenPoint(
  visual: ComputerUseVisualFrame,
  point: Extract<ComputerUseActionTarget, { kind: 'point' }>
): { x: number; y: number } {
  const frameRatio = visual.framePoints.width / visual.framePoints.height
  const imageRatio = visual.image.width / visual.image.height
  if (Math.abs(frameRatio / imageRatio - 1) > 0.03) {
    throw new Error('窗口截图与屏幕坐标比例不一致，请重新 observe')
  }
  if (point.x >= visual.image.width || point.y >= visual.image.height) {
    throw new Error('视觉坐标超出截图范围，请重新 observe')
  }
  return {
    x: Math.round(visual.framePoints.x + (point.x / visual.image.width) * visual.framePoints.width),
    y: Math.round(
      visual.framePoints.y + (point.y / visual.image.height) * visual.framePoints.height
    )
  }
}
