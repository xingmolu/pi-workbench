import { z } from 'zod'
import {
  WORKBENCH_JSON_MAX_DEPTH,
  WORKBENCH_JSON_MAX_NODES,
  WORKBENCH_PANEL_STATE_MAX_BYTES
} from './workbench-contracts'
import type {
  DesktopPluginSummary,
  JsonValue,
  PluginPanelCommand,
  PluginPanelCommandResult,
  PluginPanelContext,
  WorkbenchCommand,
  WorkbenchCommandResult,
  WorkbenchContribution,
  WorkbenchDiagnostic,
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkbenchSurface
} from './workbench-contracts'

const nonNegativeInteger = z.number().int().nonnegative()
const identifierSchema = z.string().trim().min(1).max(256)
const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'Path must not contain null bytes')
  .refine(
    (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value),
    'Path must be absolute'
  )

type JsonValidationFrame =
  { phase: 'enter'; value: unknown; depth: number } | { phase: 'leave'; value: object }

function isBoundedJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>()
  const stack: JsonValidationFrame[] = [{ phase: 'enter', value, depth: 0 }]
  let nodeCount = 0

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!
      if (frame.phase === 'leave') {
        ancestors.delete(frame.value)
        continue
      }

      nodeCount += 1
      if (nodeCount > WORKBENCH_JSON_MAX_NODES || frame.depth > WORKBENCH_JSON_MAX_DEPTH) {
        return false
      }

      const current = frame.value
      if (current === null || typeof current === 'string' || typeof current === 'boolean') {
        continue
      }
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return false
        continue
      }
      if (typeof current !== 'object' || ancestors.has(current)) return false

      const prototype = Object.getPrototypeOf(current)
      const array = Array.isArray(current)
      if (
        array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
      ) {
        return false
      }

      ancestors.add(current)
      stack.push({ phase: 'leave', value: current })
      if (array && current.length > WORKBENCH_JSON_MAX_NODES - nodeCount) return false
      const keys = Reflect.ownKeys(current)
      if (!array && keys.length > WORKBENCH_JSON_MAX_NODES - nodeCount) return false

      if (array) {
        if (keys.length !== current.length + 1 || keys[keys.length - 1] !== 'length') return false
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (keys[index] !== String(index)) return false
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) return false
          stack.push({ phase: 'enter', value: descriptor.value, depth: frame.depth + 1 })
        }
        continue
      }

      for (const key of keys) {
        if (typeof key !== 'string') return false
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) return false
        stack.push({ phase: 'enter', value: descriptor.value, depth: frame.depth + 1 })
      }
    }

    const serialized = JSON.stringify(value)
    return (
      typeof serialized === 'string' &&
      new TextEncoder().encode(serialized).byteLength <= WORKBENCH_PANEL_STATE_MAX_BYTES
    )
  } catch {
    return false
  }
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isBoundedJsonValue, {
  message: 'Value must be bounded, acyclic JSON'
})

export const pluginPanelStateSchema = jsonValueSchema

export const workbenchSurfaceSchema: z.ZodType<WorkbenchSurface> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('first-party'),
      adapter: z.enum(['files', 'review', 'terminal'])
    })
    .strict(),
  z.object({ kind: z.literal('native-view'), adapter: z.literal('browser') }).strict(),
  z.object({ kind: z.literal('sandboxed-web') }).strict()
])

export const workbenchIconSchema = z.enum([
  'files',
  'git-review',
  'terminal',
  'browser',
  'plugin',
  'flask'
])
export const workbenchActivationSchema = z.enum(['onApp', 'onProject'])

export const workbenchContributionSchema: z.ZodType<WorkbenchContribution> = z
  .object({
    pluginId: identifierSchema,
    viewId: identifierSchema,
    title: z.string().trim().min(1).max(256),
    icon: workbenchIconSchema,
    activation: workbenchActivationSchema,
    surface: workbenchSurfaceSchema
  })
  .strict()

export const workbenchDiagnosticSchema: z.ZodType<WorkbenchDiagnostic> = z
  .object({
    severity: z.enum(['warning', 'error']),
    code: identifierSchema,
    message: z.string().min(1).max(4096),
    pluginId: identifierSchema.optional(),
    viewId: identifierSchema.optional()
  })
  .strict()

export const desktopPluginSummarySchema: z.ZodType<DesktopPluginSummary> = z
  .object({
    pluginId: identifierSchema,
    name: z.string().trim().min(1).max(256),
    version: z.string().trim().min(1).max(128),
    description: z.string().max(4096).optional(),
    source: z.string().trim().min(1).max(512),
    scope: z.enum(['builtin', 'user', 'project']),
    builtin: z.boolean(),
    desktopEnabled: z.boolean(),
    hasExecutablePiResources: z.boolean(),
    requestedPermissions: z.array(identifierSchema).max(128),
    diagnostics: z.array(workbenchDiagnosticSchema).max(256)
  })
  .strict()

export const workbenchSnapshotSchema: z.ZodType<WorkbenchSnapshot> = z
  .object({
    revision: nonNegativeInteger,
    plugins: z.array(desktopPluginSummarySchema),
    contributions: z.array(workbenchContributionSchema),
    diagnostics: z.array(workbenchDiagnosticSchema)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const pluginIds = new Set<string>()
    snapshot.plugins.forEach((plugin, index) => {
      if (pluginIds.has(plugin.pluginId)) {
        context.addIssue({
          code: 'custom',
          message: 'Workbench plugin ids must be unique',
          path: ['plugins', index, 'pluginId']
        })
      }
      pluginIds.add(plugin.pluginId)
    })

    const viewIds = new Set<string>()
    snapshot.contributions.forEach((contribution, index) => {
      if (!pluginIds.has(contribution.pluginId)) {
        context.addIssue({
          code: 'custom',
          message: 'Workbench contribution must reference an existing plugin',
          path: ['contributions', index, 'pluginId']
        })
      }
      if (viewIds.has(contribution.viewId)) {
        context.addIssue({
          code: 'custom',
          message: 'Workbench view ids must be globally unique',
          path: ['contributions', index, 'viewId']
        })
      }
      viewIds.add(contribution.viewId)
    })
  })

export const workbenchBoundsSchema = z
  .object({
    x: z.number().int().nonnegative().max(100_000),
    y: z.number().int().nonnegative().max(100_000),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384)
  })
  .strict()

export const workbenchCommandSchema: z.ZodType<WorkbenchCommand> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state:get') }).strict(),
  z.object({ type: z.literal('plugins:reload') }).strict(),
  z
    .object({
      type: z.literal('plugin:set-enabled'),
      pluginId: identifierSchema,
      desktopEnabled: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal('view:set'),
      viewId: identifierSchema,
      visible: z.boolean(),
      bounds: workbenchBoundsSchema.optional()
    })
    .strict()
])

export const workbenchCommandResultSchema: z.ZodType<WorkbenchCommandResult> = z
  .object({ state: workbenchSnapshotSchema })
  .strict()

export const workbenchEventSchema: z.ZodType<WorkbenchEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), data: workbenchSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('reveal'),
      viewId: identifierSchema,
      context: jsonValueSchema.optional()
    })
    .strict()
])

export const pluginPanelContextSchema: z.ZodType<PluginPanelContext> = z
  .object({
    pluginId: identifierSchema,
    viewId: identifierSchema,
    projectPath: absolutePathSchema.nullable(),
    sessionId: z.string().min(1).nullable(),
    generation: nonNegativeInteger
  })
  .strict()

export const pluginPanelCommandSchema: z.ZodType<PluginPanelCommand> = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('context:get') }).strict(),
    z.object({ type: z.literal('state:get'), context: pluginPanelContextSchema }).strict(),
    z
      .object({
        type: z.literal('state:set'),
        context: pluginPanelContextSchema,
        value: pluginPanelStateSchema
      })
      .strict()
  ]
)

export const pluginPanelCommandResultSchema: z.ZodType<PluginPanelCommandResult> =
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('context'), context: pluginPanelContextSchema }).strict(),
    z
      .object({
        type: z.literal('state'),
        context: pluginPanelContextSchema,
        value: pluginPanelStateSchema
      })
      .strict(),
    z.object({ type: z.literal('state:stored'), context: pluginPanelContextSchema }).strict()
  ])
