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

export const pluginInstallCommandSchema = z.discriminatedUnion('type', [
  /** Opens a file dialog; resolves to the chosen path, or null. */
  z.object({ type: z.literal('pick'), kind: z.enum(['folder', 'zip']) }).strict(),
  z.object({ type: z.literal('inspect'), source: pluginInstallSourceSchema }).strict(),
  z.object({ type: z.literal('confirm'), stagingId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('cancel'), stagingId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('update'), pluginId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('uninstall'), pluginId: z.string().min(1).max(256) }).strict(),
  /** Where each installed plugin came from. */
  z.object({ type: z.literal('list') }).strict()
])
export type PluginInstallCommand = z.infer<typeof pluginInstallCommandSchema>

export type PluginInstallResult =
  | { type: 'picked'; path: string | null }
  | { type: 'preview'; preview: PluginInstallPreview }
  | { type: 'done' }
  | {
      type: 'installed'
      plugins: Record<string, { source: PluginInstallSource; version: string; installedAt: number }>
    }
