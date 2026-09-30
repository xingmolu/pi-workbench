import { subagentSummarySchema, type SubagentSummary } from './subagent'
import type { SessionStatus } from './contracts'
import { z } from 'zod'
import { runtimeIdSchema } from './agent-runtime'

/** Desktop ownership is independent of the host's native session and generation. */
export type SelectedSessionScope = { workerId: string; selectionEpoch: number }
export type DesktopCommandOrigin = {
  scope: SelectedSessionScope
  sessionId: string | null
  generation: number
}

export const selectedSessionScopeSchema: z.ZodType<SelectedSessionScope> = z
  .object({
    workerId: z.string().min(1).max(128),
    selectionEpoch: z.number().int().nonnegative()
  })
  .strict()
export const desktopCommandOriginSchema: z.ZodType<DesktopCommandOrigin> = z
  .object({
    scope: selectedSessionScopeSchema,
    sessionId: z.string().nullable(),
    generation: z.number().int().nonnegative()
  })
  .strict()

/** Read-only task relationship and bounded activity for Sidebar/conversation projection. */
export type LiveSessionTaskRelation = {
  taskId: string
  parentWorkerId: string
  parentSessionId?: string
  parentGeneration?: number
  createdAt: number
  progress?: SubagentSummary
}

const liveSessionTaskRelationSchema: z.ZodType<LiveSessionTaskRelation> = z
  .object({
    taskId: z.string().min(1).max(256),
    parentWorkerId: z.string().min(1).max(128),
    parentSessionId: z.string().min(1).max(1024).optional(),
    parentGeneration: z.number().int().nonnegative().optional(),
    createdAt: z.number().finite(),
    progress: subagentSummarySchema.optional()
  })
  .strict()

export type LiveSessionSummary = {
  workerId: string
  runtimeId?: string
  cwd: string
  sessionPath: string | null
  sessionId: string | null
  generation: number | null
  status: SessionStatus | 'opening'
  selected: boolean
  title?: string
  sessionTask?: LiveSessionTaskRelation
}

export const liveSessionSummarySchema: z.ZodType<LiveSessionSummary> = z
  .object({
    workerId: z.string().min(1).max(128),
    runtimeId: runtimeIdSchema.optional(),
    cwd: z.string().min(1),
    sessionPath: z.string().nullable(),
    sessionId: z.string().nullable(),
    generation: z.number().int().nonnegative().nullable(),
    status: z.enum(['idle', 'running', 'awaiting-approval', 'error', 'stopped', 'opening']),
    selected: z.boolean(),
    title: z.string().max(200).optional(),
    sessionTask: liveSessionTaskRelationSchema.optional()
  })
  .strict()

export function sameSelectedScope(
  left: SelectedSessionScope | null,
  right: SelectedSessionScope | null
): boolean {
  return left === null || right === null
    ? left === right
    : left.workerId === right.workerId && left.selectionEpoch === right.selectionEpoch
}
