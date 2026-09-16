import { z } from 'zod'

export const MAX_SKILLS = 256
export const MAX_SKILL_BYTES = 64 * 1024
export const safeSkillName = (name: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64
const identity = { sessionId: z.string().min(1), generation: z.number().int().nonnegative() }
export type SkillIdentity = { sessionId: string; generation: number }
export const skillsListSchema = z.object({ type: z.literal('skills:list'), ...identity }).strict()
export const skillsDetailSchema = z
  .object({ type: z.literal('skills:detail'), ...identity, id: z.string().uuid() })
  .strict()
export type SkillsCommand = z.infer<typeof skillsListSchema> | z.infer<typeof skillsDetailSchema>
export const skillSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(128),
    description: z.string().max(1024),
    scope: z.enum(['user', 'project', 'temporary']),
    origin: z.enum(['package', 'top-level']),
    mode: z.enum(['model-and-manual', 'manual-only']),
    canInsert: z.boolean()
  })
  .strict()
export type SkillSummary = z.infer<typeof skillSummarySchema>
export const skillsCatalogSchema = z
  .object({
    ...identity,
    skills: z.array(skillSummarySchema).max(MAX_SKILLS),
    total: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict()
export type SkillsCatalogSnapshot = z.infer<typeof skillsCatalogSchema>
export const skillDetailSchema = z
  .object({ ...identity, skill: skillSummarySchema, preview: z.string().max(MAX_SKILL_BYTES) })
  .strict()
export type SkillDetail = z.infer<typeof skillDetailSchema>
