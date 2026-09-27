import { z } from 'zod'

const identity = {
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  /** Canonical entry ID of the user message that started the turn. */
  entryId: z.string().min(1)
}

export const checkpointPlanCommandSchema = z
  .object({ type: z.literal('checkpoint:plan'), ...identity })
  .strict()
export const checkpointRestoreCommandSchema = z
  .object({
    type: z.literal('checkpoint:restore'),
    ...identity,
    /** Overwrite files that changed after Pi last wrote them. */
    force: z.boolean()
  })
  .strict()
export type CheckpointCommand =
  z.infer<typeof checkpointPlanCommandSchema> | z.infer<typeof checkpointRestoreCommandSchema>

export const checkpointTurnStateSchema = z
  .object({ entryId: z.string().min(1), state: z.enum(['available', 'restored']) })
  .strict()
export type CheckpointTurnState = z.infer<typeof checkpointTurnStateSchema>

export const checkpointFilePlanSchema = z
  .object({
    path: z.string(),
    /** Delete files the turn created; otherwise write back the captured content. */
    action: z.enum(['restore', 'delete']),
    /** `conflict`: changed since Pi's last write. `uncaptured`: too large or not a file. */
    status: z.enum(['ready', 'conflict', 'uncaptured'])
  })
  .strict()
export type CheckpointFilePlan = z.infer<typeof checkpointFilePlanSchema>

export const checkpointPlanSchema = z
  .object({
    entryId: z.string(),
    /** Later turns whose tool changes are rewound too. */
    laterTurns: z.number().int().nonnegative(),
    files: z.array(checkpointFilePlanSchema)
  })
  .strict()
export type CheckpointPlan = z.infer<typeof checkpointPlanSchema>

export const checkpointRestoreOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('conflict'), plan: checkpointPlanSchema }).strict(),
  z
    .object({
      status: z.enum(['restored', 'partial']),
      restored: z.number().int().nonnegative(),
      skipped: z.array(z.string()),
      failed: z.array(z.string())
    })
    .strict()
])
export type CheckpointRestoreOutcome = z.infer<typeof checkpointRestoreOutcomeSchema>

export const checkpointResultSchema = z
  .object({
    kind: z.literal('checkpoint'),
    plan: checkpointPlanSchema.nullable().optional(),
    outcome: checkpointRestoreOutcomeSchema.optional()
  })
  .strict()
export type HostCheckpointResult = z.infer<typeof checkpointResultSchema>
