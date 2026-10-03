import { z } from 'zod'

export const PLUGIN_INSTALL_CHANNEL = 'pi:plugin-install'

export const pluginInstallSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('zip'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('git'), url: z.string().min(1).max(2048) }).strict()
])
export type PluginInstallSource = z.infer<typeof pluginInstallSourceSchema>

/** What the user reviews before a plugin is installed. */
export type PluginInstallPreview = {
  stagingId: string
  pluginId: string
  name: string
  version: string
  description?: string
  /** Permissions the manifest requests; installing grants them. */
  permissions: string[]
  /** It has a main script, which runs with the user's own rights. */
  runsCode: boolean
  /** The installed version this would replace, if any. */
  existingVersion: string | null
  source: PluginInstallSource
  /** Only plugins from the official list will be verified; none are yet. */
  verified: boolean
}

export const PLUGIN_TEMPLATES = ['panel', 'command', 'agent-tool'] as const
export type PluginTemplate = (typeof PLUGIN_TEMPLATES)[number]

/** Plugin ids are lowercase and namespaced, e.g. `acme.notes`. */
export const pluginIdSchema = z
  .string()
  .max(128)
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)+$/,
    'Expected a namespaced lowercase id'
  )

const folderPathSchema = z.string().min(1).max(4096)

export const pluginInstallCommandSchema = z.discriminatedUnion('type', [
  /** Opens a file dialog; resolves to the chosen path, or null. `parent` picks where a new
   * plugin is created. */
  z.object({ type: z.literal('pick'), kind: z.enum(['folder', 'zip', 'parent']) }).strict(),
  z.object({ type: z.literal('inspect'), source: pluginInstallSourceSchema }).strict(),
  z.object({ type: z.literal('confirm'), stagingId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('cancel'), stagingId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('update'), pluginId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('uninstall'), pluginId: z.string().min(1).max(256) }).strict(),
  /** Where each installed plugin came from, and the folders under development. */
  z.object({ type: z.literal('list') }).strict(),
  /** Loads a plugin from its folder and reloads it whenever a file there changes. */
  z.object({ type: z.literal('develop'), path: folderPathSchema }).strict(),
  z.object({ type: z.literal('undevelop'), path: folderPathSchema }).strict(),
  /** Rediscovers the plugin and starts a fresh process for it. */
  z.object({ type: z.literal('reload'), pluginId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('logs'), pluginId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('clear-logs'), pluginId: z.string().min(1).max(256) }).strict(),
  /** Writes a new plugin from a template into `<parentPath>/<last part of id>` and develops it. */
  z
    .object({
      type: z.literal('scaffold'),
      template: z.enum(PLUGIN_TEMPLATES),
      id: pluginIdSchema,
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        // It is written into JSON and HTML as it is.
        .refine(
          (name) => !/[<>&"\\]/.test(name) && [...name].every((c) => c.charCodeAt(0) >= 32),
          'Expected a plain name'
        ),
      parentPath: folderPathSchema
    })
    .strict()
])
export type PluginInstallCommand = z.infer<typeof pluginInstallCommandSchema>

export type PluginLogLine = {
  at: number
  level: 'info' | 'warning' | 'error'
  text: string
  /** `panel` for a view's console; absent for the plugin process. */
  source?: string
}

/** A folder being developed and what it currently holds. */
export type PluginDevelopmentFolder = {
  path: string
  pluginId: string | null
  /** Why it does not load, e.g. a manifest error. */
  problem: string | null
}

export type PluginInstallResult =
  | { type: 'picked'; path: string | null }
  | { type: 'preview'; preview: PluginInstallPreview }
  | { type: 'done' }
  | {
      type: 'installed'
      plugins: Record<string, { source: PluginInstallSource; version: string; installedAt: number }>
      development: PluginDevelopmentFolder[]
    }
  | { type: 'logs'; lines: PluginLogLine[] }
  | { type: 'created'; path: string; pluginId: string }
