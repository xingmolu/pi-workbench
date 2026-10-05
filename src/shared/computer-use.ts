import { z } from 'zod'
import { axHitTargetSchema, DESKTOP_CONTROL_AX_LIMITS } from './desktop-control'
import { t } from './i18n'

export const COMPUTER_USE_LIMITS = {
  maxStateIdLength: 80,
  maxQueryLength: 200,
  maxResults: 20,
  maxTextLength: 200,
  maxImageDataLength: 10_000_000,
  maxImageDimension: 1600,
  maxVisualStateAgeMs: 30_000,
  maxAppNameLength: 80,
  /** Clipboard paste carries long text in one step; typing stays short. */
  maxPasteLength: 20_000,
  maxValueLength: 2000,
  maxSteps: 10,
  maxScrollAmount: 20,
  maxApps: 40,
  maxWindows: 20
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
export const COMPUTER_USE_MODIFIERS = ['cmd', 'ctrl', 'alt', 'shift'] as const
export type ComputerUseModifier = (typeof COMPUTER_USE_MODIFIERS)[number]
const MODIFIER_ALIASES: Record<string, ComputerUseModifier> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift'
}
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
/** Printable keys a shortcut may use, besides the named keys above. */
const SHORTCUT_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789-=[]\\;',./`"

export type ComputerUseKeyChord = { key: string; modifiers: ComputerUseModifier[] }

/**
 * Shortcuts that act outside the target window: switching or quitting apps, Spotlight,
 * force quit, locking, logging out and switching Spaces.
 */
const BLOCKED_SHORTCUTS = [
  'cmd+Tab',
  'cmd+shift+Tab',
  'cmd+Space',
  'ctrl+Space',
  'cmd+alt+Escape',
  'cmd+q',
  'cmd+alt+q',
  'cmd+ctrl+q',
  'cmd+shift+q',
  'cmd+alt+shift+q',
  'cmd+alt+d',
  'ctrl+ArrowUp',
  'ctrl+ArrowDown',
  'ctrl+ArrowLeft',
  'ctrl+ArrowRight',
  'alt+Tab',
  'alt+F4',
  'ctrl+alt+Delete',
  'ctrl+alt+t',
  'super+l'
]

/** Parses "Enter", "cmd+s" or "ctrl+shift+Tab"; null when it is not a key this tool may press. */
export function parseComputerUseKey(spec: string): ComputerUseKeyChord | null {
  const parts = spec.split('+').map((part) => part.trim())
  if (parts.some((part) => !part)) return null
  const name = parts.pop()!
  const modifiers: ComputerUseModifier[] = []
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (!modifier || modifiers.includes(modifier)) return null
    modifiers.push(modifier)
  }
  const named = [...COMPUTER_USE_KEYS, ...FUNCTION_KEYS].find(
    (key) => key.toLowerCase() === name.toLowerCase()
  )
  const key =
    named ??
    (name.length === 1 && SHORTCUT_CHARACTERS.includes(name.toLowerCase())
      ? name.toLowerCase()
      : null)
  if (!key) return null
  return { key, modifiers: COMPUTER_USE_MODIFIERS.filter((item) => modifiers.includes(item)) }
}

const chordText = (chord: ComputerUseKeyChord): string =>
  [...chord.modifiers, chord.key].join('+').toLowerCase()
const BLOCKED = new Set(
  BLOCKED_SHORTCUTS.map((spec) => {
    const chord = parseComputerUseKey(spec.replace(/^super\+/, 'cmd+'))
    return chord ? chordText(chord) : spec.toLowerCase()
  })
)

/** True for a shortcut that would reach other apps or the system rather than the target window. */
export function isBlockedComputerUseShortcut(chord: ComputerUseKeyChord): boolean {
  return BLOCKED.has(chordText(chord))
}

export const computerUseKeySchema = z
  .string()
  .min(1)
  .max(40)
  .refine((spec) => parseComputerUseKey(spec) !== null, {
    message: 'Unsupported key; use a named key such as Enter, or modifiers like cmd+s'
  })
  .refine(
    (spec) => {
      const chord = parseComputerUseKey(spec)
      return !chord || !isBlockedComputerUseShortcut(chord)
    },
    { message: 'This shortcut acts outside the target window and is not allowed' }
  )
export const computerUseIntentSchema = z.enum([
  'press',
  'move',
  'type',
  'key',
  'scroll',
  'drag',
  'paste',
  'set_value',
  'secondary'
])
export const computerUseScrollDirectionSchema = z.enum(['up', 'down', 'left', 'right'])
/** Accessibility actions besides pressing: menus, steppers, pickers, confirm and cancel. */
export const computerUseSecondaryActionSchema = z.enum([
  'menu',
  'increment',
  'decrement',
  'pick',
  'confirm',
  'cancel'
])

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

const computerUseStepShape = {
  target: computerUseActionTargetSchema.optional(),
  /** Where a drag ends. */
  to: computerUseActionTargetSchema.optional(),
  text: z.string().min(1).max(COMPUTER_USE_LIMITS.maxPasteLength).optional(),
  key: computerUseKeySchema.optional(),
  direction: computerUseScrollDirectionSchema.optional(),
  amount: z.number().int().min(1).max(COMPUTER_USE_LIMITS.maxScrollAmount).optional(),
  value: z.string().max(COMPUTER_USE_LIMITS.maxValueLength).optional(),
  name: computerUseSecondaryActionSchema.optional()
}
export const computerUseStepSchema = z
  .object({ intent: computerUseIntentSchema, ...computerUseStepShape })
  .strict()
export type ComputerUseStep = z.infer<typeof computerUseStepSchema>

/** What each intent needs; returns the problem, or null when the step is complete. */
export function computerUseStepProblem(step: ComputerUseStep): string | null {
  const needs: Record<ComputerUseStep['intent'], (keyof ComputerUseStep)[]> = {
    press: ['target'],
    move: ['target'],
    type: ['target', 'text'],
    key: ['key'],
    scroll: ['direction'],
    drag: ['target', 'to'],
    paste: ['text'],
    set_value: ['target', 'value'],
    secondary: ['target', 'name']
  }
  const missing = needs[step.intent].find((field) => step[field] === undefined)
  if (missing) return t('{intent} 操作需要 {field}', { intent: step.intent, field: missing })
  if (step.intent === 'type' && step.text!.length > COMPUTER_USE_LIMITS.maxTextLength)
    return t('type 最多 {max} 个字符，更长的文本请用 paste', {
      max: COMPUTER_USE_LIMITS.maxTextLength
    })
  if (step.intent === 'set_value' && step.target?.kind !== 'ref')
    return t('set_value 需要语义元素 ref 作为 target')
  return null
}

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
      /** A window of that app, by part of its title; the app's focused window when omitted. */
      window: z.string().trim().min(1).max(200).optional(),
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
      ...computerUseStepShape,
      intent: computerUseIntentSchema.optional(),
      /** Several steps in one call, run in order; the first failure stops the rest. */
      steps: z.array(computerUseStepSchema).min(1).max(COMPUTER_USE_LIMITS.maxSteps).optional()
    })
    .strict()
    .superRefine((value, context) => {
      if (Boolean(value.intent) === Boolean(value.steps))
        context.addIssue({
          code: 'custom',
          message: 'act needs either intent or steps',
          path: ['intent']
        })
    }),
  z.object({ action: z.literal('apps') }).strict(),
  z
    .object({
      action: z.literal('windows'),
      app: z.string().trim().min(1).max(COMPUTER_USE_LIMITS.maxAppNameLength)
    })
    .strict()
])
export type ComputerUseOperation = z.infer<typeof computerUseOperationSchema>

export const computerUseAppSummarySchema = z
  .object({
    name: z.string().max(80),
    bundleId: z.string().max(80),
    active: z.boolean(),
    hidden: z.boolean(),
    windows: z.number().int().nonnegative()
  })
  .strict()
export const computerUseWindowSummarySchema = z
  .object({
    title: z.string().max(200),
    focused: z.boolean(),
    minimized: z.boolean(),
    frame: computerUseFrameRectSchema.optional()
  })
  .strict()

export const computerUseResultSchema = z.union([
  computerUseObservationSchema,
  z
    .object({
      kind: z.literal('apps'),
      apps: z.array(computerUseAppSummarySchema).max(COMPUTER_USE_LIMITS.maxApps)
    })
    .strict(),
  z
    .object({
      kind: z.literal('windows'),
      app: z.string().max(80),
      bundleId: z.string().max(80),
      windows: z.array(computerUseWindowSummarySchema).max(COMPUTER_USE_LIMITS.maxWindows)
    })
    .strict(),
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
      /** Steps of a multi-step act that ran, in order. */
      steps: z.number().int().min(1).max(COMPUTER_USE_LIMITS.maxSteps).optional(),
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
    throw new Error(t('窗口截图与屏幕坐标比例不一致，请重新 observe'))
  }
  if (point.x >= visual.image.width || point.y >= visual.image.height) {
    throw new Error(t('视觉坐标超出截图范围，请重新 observe'))
  }
  return {
    x: Math.round(visual.framePoints.x + (point.x / visual.image.width) * visual.framePoints.width),
    y: Math.round(
      visual.framePoints.y + (point.y / visual.image.height) * visual.framePoints.height
    )
  }
}
