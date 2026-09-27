import { z } from 'zod'

/** Permission names follow the common manifest.json format vocabulary where one exists. */
export const PLUGIN_PERMISSIONS = {
  'ui.view': 'low',
  'ui.command': 'low',
  notify: 'low',
  storage: 'low',
  'fs.read': 'medium',
  'git.read': 'medium',
  'clipboard.write': 'medium',
  'shell.openExternal': 'medium',
  'fs.write': 'high',
  'git.write': 'high',
  'agent.tools': 'high',
  'agent.skills': 'high',
  'mcp.local': 'high',
  'mcp.remote': 'high',
  'net.fetch': 'high'
} as const satisfies Record<string, 'low' | 'medium' | 'high'>

export type PluginPermission = keyof typeof PLUGIN_PERMISSIONS
export type PluginPermissionRisk = (typeof PLUGIN_PERMISSIONS)[PluginPermission]

export function isKnownPluginPermission(value: string): value is PluginPermission {
  return Object.hasOwn(PLUGIN_PERMISSIONS, value)
}

/** Permissions a view-only plugin can hold without an explicit grant, as before plugins ran code. */
export const IMPLICIT_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set(['ui.view'])

export const PLUGIN_ERROR_CODES = [
  'PERMISSION_DENIED',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'CONFLICT',
  'TIMEOUT',
  'PLUGIN_CRASHED',
  'UNSUPPORTED',
  'INTERNAL'
] as const
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

export class PluginApiError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PluginApiError'
  }
}

const localIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/, 'Expected a lowercase identifier')

/** Parameter schemas for every host method a plugin process may call. The method name is
 * the allowlist: anything not listed here is UNSUPPORTED before permissions are consulted. */
export const PLUGIN_HOST_METHODS = {
  'commands.register': {
    permission: null,
    params: z.object({ id: localIdSchema }).strict()
  },
  'commands.unregister': {
    permission: null,
    params: z.object({ id: localIdSchema }).strict()
  },
  'ui.showToast': {
    permission: 'notify',
    params: z.object({ message: z.string().trim().min(1).max(500) }).strict()
  },
  'ui.openView': {
    permission: 'ui.view',
    params: z.object({ id: localIdSchema }).strict()
  },
  'storage.get': {
    permission: 'storage',
    params: z.object({ key: z.string().min(1).max(128) }).strict()
  },
  'storage.set': {
    permission: 'storage',
    params: z.object({ key: z.string().min(1).max(128), value: z.unknown() }).strict()
  },
  'project.current': {
    permission: null,
    params: z.object({}).strict()
  }
} as const satisfies Record<string, { permission: PluginPermission | null; params: z.ZodType }>

export type PluginHostMethod = keyof typeof PLUGIN_HOST_METHODS

/** Messages on the plugin process port. Both directions validate before acting. */
export const pluginProcessMessageSchema = z.discriminatedUnion('kind', [
  // child → host
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('load-failed'), message: z.string().max(2000) }).strict(),
  z
    .object({
      kind: z.literal('call'),
      id: z.number().int().nonnegative(),
      method: z.string().max(128),
      params: z.unknown()
    })
    .strict(),
  z
    .object({
      kind: z.literal('reply'),
      id: z.number().int().nonnegative(),
      ok: z.boolean(),
      value: z.unknown().optional(),
      code: z.enum(PLUGIN_ERROR_CODES).optional(),
      message: z.string().max(2000).optional()
    })
    .strict(),
  // host → child
  z
    .object({
      kind: z.literal('load'),
      pluginId: z.string(),
      mainPath: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('invoke'),
      id: z.number().int().nonnegative(),
      target: z.enum(['command']),
      name: z.string().max(128)
    })
    .strict(),
  z.object({ kind: z.literal('unload') }).strict()
])
export type PluginProcessMessage = z.infer<typeof pluginProcessMessageSchema>

export const PLUGIN_TIMEOUTS = { load: 15_000, command: 30_000, unload: 5_000, call: 30_000 }

/** Storage values are bounded like panel state. */
export const PLUGIN_STORAGE_MAX_BYTES = 32 * 1024
