import { z } from 'zod'

export const WORKSPACE_FILES_CHANNEL = 'pi:workspace-files'
const relativePath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes(':') &&
      (value === '' ||
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
  )
export const workspaceRelativePathSchema = relativePath.refine((value) => value.length > 0)
const projectPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'))
export const workspaceFilesCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('list'),
      projectPath,
      path: relativePath.default(''),
      includeHidden: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('read'),
      projectPath,
      path: relativePath.refine((value) => value.length > 0)
    })
    .strict(),
  z
    .object({
      type: z.literal('search'),
      projectPath,
      query: z.string().trim().min(1).max(100),
      includeHidden: z.boolean().optional()
    })
    .strict()
])

export type WorkspaceFilesCommand = z.input<typeof workspaceFilesCommandSchema>
export type WorkspaceFileEntry = {
  name: string
  path: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
}
export type WorkspaceFilesResult =
  | { type: 'list'; entries: WorkspaceFileEntry[]; truncated: boolean }
  | { type: 'read'; path: string; text: string; size: number }
  | { type: 'search'; entries: WorkspaceFileEntry[]; truncated: boolean }
