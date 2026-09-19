import { z } from 'zod'
import { navigationLibrarySchema } from './navigation-library'

const searchShape = {
  query: z.string().max(200), limit: z.number().int().min(1).max(50),
  includeHidden: z.boolean().optional(), includeArchived: z.boolean().optional(),
  navigation: navigationLibrarySchema.optional()
}
export const sessionSearchCommandSchema = z
  .object({ type: z.literal('session:search'), ...searchShape })
  .strict()
export const projectSearchCommandSchema = z
  .object({ type: z.literal('project:search'), ...searchShape })
  .strict()
export type SessionSearchCommand = z.infer<typeof sessionSearchCommandSchema>
export type ProjectSearchCommand = z.infer<typeof projectSearchCommandSchema>
export const sessionSearchItemSchema = z
  .object({
    id: z.string().min(1).max(1024),
    title: z.string().min(1).max(200),
    sessionPath: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    projectName: z.string().min(1).max(200),
    modified: z.iso.datetime()
  })
  .strict()
const metadata = {
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  skippedDirectories: z.number().int().nonnegative(),
  skippedEntries: z.number().int().nonnegative()
}
export const sessionSearchResultSchema = z
  .object({ items: z.array(sessionSearchItemSchema).max(50), ...metadata })
  .strict()
export const projectSearchResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            cwd: z.string().min(1).max(4096),
            projectName: z.string().min(1).max(200),
            available: z.boolean()
          })
          .strict()
      )
      .max(50),
    ...metadata
  })
  .strict()
export type SessionSearchResult = z.infer<typeof sessionSearchResultSchema>
export type ProjectSearchResult = z.infer<typeof projectSearchResultSchema>
export type SessionSearchItem = z.infer<typeof sessionSearchItemSchema>
