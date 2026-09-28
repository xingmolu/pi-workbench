import { z } from 'zod'

/** Permission names follow the common manifest.json format vocabulary where one exists. */
export const PLUGIN_PERMISSIONS = {
  'ui.view': 'low',
  'ui.command': 'low',
  'ui.theme': 'low',
  notify: 'low',
  storage: 'low',
  'fs.read': 'medium',
  'git.read': 'medium',
  'clipboard.write': 'medium',
  'shell.openExternal': 'medium',
  'fs.write': 'high',
  'git.write': 'high',
  'git.push': 'high',
  'agent.tools': 'high',
  'agent.skills': 'high',
  'mcp.local': 'high',
  'mcp.remote': 'high',
  'net.fetch': 'high',
  /** Host a native browser view that Pi can drive; bundled plugins only. */
  'browser.control': 'high',
  /** Host terminal panels that start the user's login shell; bundled plugins only. */
  'terminal.shell': 'high'
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

export const PLUGIN_FS_MAX_READ_BYTES = 1024 * 1024
export const PLUGIN_FS_MAX_WRITE_CHARS = 2 * 1024 * 1024
export const PLUGIN_FS_MAX_ENTRIES = 2000

/** Project-relative, forward-slash paths. Containment is re-checked on the real path in Main. */
const projectPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\\') &&
      !value.split('/').includes('..'),
    'Expected a path inside the project'
  )
const gitPathsSchema = z.array(projectPathSchema).min(1).max(500)

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
  /** Toasts are attributed to the plugin, so they need no permission (as in manifest.json). */
  'ui.showToast': {
    permission: null,
    params: z.object({ message: z.string().trim().min(1).max(500) }).strict()
  },
  'ui.notify': {
    permission: null,
    params: z.object({ message: z.string().trim().min(1).max(500) }).strict()
  },
  /** floating panel: opens the plugin's `panel` view, or its first view. */
  'ui.openPanel': {
    permission: 'ui.view',
    params: z.object({}).passthrough()
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
  },
  'fs.list': {
    permission: 'fs.read',
    params: z.object({ path: projectPathSchema.default('.') }).strict()
  },
  'fs.stat': {
    permission: 'fs.read',
    params: z.object({ path: projectPathSchema }).strict()
  },
  'fs.readText': {
    permission: 'fs.read',
    params: z.object({ path: projectPathSchema }).strict()
  },
  'fs.writeText': {
    permission: 'fs.write',
    params: z
      .object({ path: projectPathSchema, content: z.string().max(PLUGIN_FS_MAX_WRITE_CHARS) })
      .strict()
  },
  'git.status': {
    permission: 'git.read',
    params: z.object({}).strict()
  },
  'git.diff': {
    permission: 'git.read',
    params: z
      .object({ path: projectPathSchema.optional(), staged: z.boolean().default(false) })
      .strict()
  },
  'git.log': {
    permission: 'git.read',
    params: z.object({ limit: z.number().int().min(1).max(200).default(30) }).strict()
  },
  'git.stage': {
    permission: 'git.write',
    params: z.object({ paths: gitPathsSchema }).strict()
  },
  'git.unstage': {
    permission: 'git.write',
    params: z.object({ paths: gitPathsSchema }).strict()
  },
  'git.discard': {
    permission: 'git.write',
    params: z.object({ paths: gitPathsSchema }).strict()
  },
  'git.commit': {
    permission: 'git.write',
    params: z.object({ message: z.string().trim().min(1).max(5000) }).strict()
  },
  /** Always confirmed, whatever the project's approval level. */
  'git.push': {
    permission: 'git.push',
    params: z.object({}).strict()
  },
  /** Binds a handler to a tool declared in `contributes.agentTools`. Process only. */
  'agent.registerTool': {
    permission: 'agent.tools',
    params: z.object({ name: localIdSchema }).strict()
  },
  'agent.unregisterTool': {
    permission: 'agent.tools',
    params: z.object({ name: localIdSchema }).strict()
  },
  /** Declared settings merged with the user's values. */
  'plugin.getSettings': {
    permission: null,
    params: z.object({}).strict()
  },
  'plugin.setSettings': {
    permission: null,
    params: z.object({ values: z.record(z.string(), z.unknown()) }).strict()
  },
  /** A private directory for the plugin's own files. Process only. */
  'plugin.getDataPath': {
    permission: null,
    params: z.object({}).strict()
  },
  /** The open project, as `workspace.get` panel channel. */
  'workspace.get': {
    permission: null,
    params: z.object({}).strict()
  },
  'app.getAppearance': {
    permission: null,
    params: z.object({}).strict()
  }
} as const satisfies Record<string, { permission: PluginPermission | null; params: z.ZodType }>

/** Methods a sandboxed view may call directly; command registration stays in the process. */
const PROCESS_ONLY_METHODS: ReadonlySet<string> = new Set([
  'agent.registerTool',
  'agent.unregisterTool',
  'plugin.setSettings',
  'plugin.getDataPath'
])

export function isViewCallable(method: PluginHostMethod): boolean {
  return !method.startsWith('commands.') && !PROCESS_ONLY_METHODS.has(method)
}

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
      /** `panel` forwards a view channel the host does not implement to `onPanelInvoke`. */
      target: z.enum(['command', 'tool', 'panel']),
      name: z.string().max(128),
      /** Tool input, already validated against the declared schema by the agent host. */
      input: z.unknown().optional()
    })
    .strict(),
  z.object({ kind: z.literal('unload') }).strict()
])
export type PluginProcessMessage = z.infer<typeof pluginProcessMessageSchema>

export const PLUGIN_TIMEOUTS = {
  load: 15_000,
  command: 30_000,
  tool: 120_000,
  unload: 5_000,
  call: 30_000
}

/** Tool results returned to the model are bounded like MCP results. */
export const PLUGIN_TOOL_MAX_RESULT_CHARS = 128 * 1024

/** Plugin tool results become plain text for the model: strings pass, `{ content: [{ type:
 * 'text', text }] }` is joined, anything else is shown as JSON. */
export function pluginToolResultText(value: unknown): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { content?: unknown }).content)
  )
    text = ((value as { content: unknown[] }).content as { type?: unknown; text?: unknown }[])
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  else text = value === undefined ? '' : (JSON.stringify(value) ?? '')
  if (text.length > PLUGIN_TOOL_MAX_RESULT_CHARS)
    throw new PluginApiError('INVALID_ARGUMENT', '插件工具结果超过上限')
  return text || '（插件工具没有返回内容）'
}

/** Storage values are bounded like panel state. */
export const PLUGIN_STORAGE_MAX_BYTES = 32 * 1024
