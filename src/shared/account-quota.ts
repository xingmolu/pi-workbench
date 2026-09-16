import { z } from 'zod'

export const quotaWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    windowMinutes: z.number().positive().optional(),
    resetsAt: z.number().int().nonnegative().optional()
  })
  .strict()
export const accountQuotaSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    authGeneration: z.number().int().nonnegative(),
    state: z.enum(['available', 'unavailable', 'signed-out']),
    fetchedAt: z.string().datetime(),
    plan: z.string().max(80).optional(),
    windows: z
      .array(z.object({ label: z.string().max(120), ...quotaWindowSchema.shape }).strict())
      .max(20),
    message: z.string().max(200).optional()
  })
  .strict()
export type AccountQuota = z.infer<typeof accountQuotaSchema>
export const accountQuotaCommandSchema = z
  .object({
    type: z.literal('account:quota'),
    providerId: z.string().min(1).max(128)
  })
  .strict()
