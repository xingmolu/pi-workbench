import { z } from 'zod'
import type { PiPackageRoot, PiPackageRootsMessage } from './workbench-host-contracts'

const nonNegativeInteger = z.number().int().nonnegative()
const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'Path must not contain null bytes')
  .refine(
    (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value),
    'Path must be absolute'
  )

export const piPackageRootSchema: z.ZodType<PiPackageRoot> = z
  .object({
    path: absolutePathSchema,
    source: z.string().trim().min(1).max(512),
    scope: z.enum(['user', 'project']),
    hasExecutablePiResources: z.boolean()
  })
  .strict()

export const piPackageRootsMessageSchema: z.ZodType<PiPackageRootsMessage> = z
  .object({
    type: z.literal('desktop-plugin-roots'),
    sessionId: z.string().min(1).nullable(),
    generation: nonNegativeInteger,
    roots: z.array(piPackageRootSchema).max(4096)
  })
  .strict()
