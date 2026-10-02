import { z } from 'zod'
import { t } from './i18n/index.ts'

export const NAVIGATION_LIBRARY_CHANNEL = 'pi:navigation-library'
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), t('路径无效'))
const stamp = z.number().int().nonnegative()
const projectPreferenceSchema = z.strictObject({
  name: z.string().trim().max(80).optional(),
  pinnedAt: stamp.optional(),
  hiddenAt: stamp.optional()
})
const sessionPreferenceSchema = z.strictObject({
  cwd: path,
  title: z.string().max(200).optional(),
  pinnedAt: stamp.optional(),
  archivedAt: stamp.optional()
})

/** Presentation metadata only. Never stores credentials or rewrites Pi session files. */
export const navigationLibrarySchema = z.strictObject({
  version: z.literal(1),
  revision: stamp,
  projects: z
    .record(path, projectPreferenceSchema)
    .refine((items) => Object.keys(items).length <= 1000),
  sessions: z
    .record(path, sessionPreferenceSchema)
    .refine((items) => Object.keys(items).length <= 5000),
  layout: z
    .strictObject({
      sidebarWidth: z.number().int().min(208).max(360).optional(),
      workbenchWidth: z.number().int().min(252).max(1200).optional()
    })
    .default({})
})
export type NavigationLibraryState = z.infer<typeof navigationLibrarySchema>
export type ProjectPreference = z.infer<typeof projectPreferenceSchema>
export type SessionPreference = z.infer<typeof sessionPreferenceSchema>
export const emptyNavigationLibrary = (): NavigationLibraryState => ({
  version: 1,
  revision: 0,
  projects: {},
  sessions: {},
  layout: {}
})

export const navigationLibraryCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get') }),
  z.strictObject({ type: z.literal('project:rename'), cwd: path, name: z.string().trim().max(80) }),
  z.strictObject({ type: z.literal('project:pin'), cwd: path, pinned: z.boolean() }),
  z.strictObject({ type: z.literal('project:hide'), cwd: path }),
  z.strictObject({ type: z.literal('project:restore'), cwd: path }),
  z.strictObject({ type: z.literal('project:reveal'), cwd: path }),
  z.strictObject({ type: z.literal('project:copy-path'), cwd: path }),
  z.strictObject({
    type: z.literal('session:rename'),
    cwd: path,
    path,
    name: z.string().trim().min(1).max(80)
  }),
  z.strictObject({
    type: z.literal('session:pin'),
    cwd: path,
    path,
    title: z.string().max(200),
    pinned: z.boolean()
  }),
  z.strictObject({
    type: z.literal('session:archive'),
    cwd: path,
    path,
    title: z.string().max(200),
    archived: z.boolean()
  }),
  z.strictObject({ type: z.literal('layout:save'), layout: navigationLibrarySchema.shape.layout })
])
export type NavigationLibraryCommand = z.infer<typeof navigationLibraryCommandSchema>

export function projectDisplayName(
  state: NavigationLibraryState | undefined,
  cwd: string,
  fallback: string
): string {
  return state?.projects[cwd]?.name?.trim() || fallback
}
export function projectIsHidden(state: NavigationLibraryState | undefined, cwd: string): boolean {
  return state?.projects[cwd]?.hiddenAt !== undefined
}
export function sessionIsArchived(
  state: NavigationLibraryState | undefined,
  sessionPath: string
): boolean {
  return state?.sessions[sessionPath]?.archivedAt !== undefined
}
/** Stable pin order; unpinned rows retain their catalog order. */
export function comparePinned(
  left: { pinnedAt?: number } | undefined,
  right: { pinnedAt?: number } | undefined
): number {
  return (left?.pinnedAt ?? Infinity) - (right?.pinnedAt ?? Infinity) || 0
}
