import { z } from 'zod'

const requestIdSchema = z.string().min(1).max(128)
const sessionIdSchema = z.string().min(1).max(1024)
const generationSchema = z.number().int().nonnegative()
const taskIdSchema = z.string().min(1).max(256)
const promptSchema = z.string().min(1).max(200_000)
const superviseModeSchema = z.enum(['snapshot', 'any', 'all'])

const requestBase = {
  type: z.literal('session-task-request'),
  requestId: requestIdSchema,
  sessionId: sessionIdSchema,
  generation: generationSchema
}

export const sessionTaskRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...requestBase, action: z.literal('spawn'), prompt: promptSchema }).strict(),
  z
    .object({
      ...requestBase,
      action: z.literal('send'),
      taskId: taskIdSchema,
      prompt: promptSchema
    })
    .strict(),
  z.object({ ...requestBase, action: z.literal('status'), taskId: taskIdSchema }).strict(),
  z
    .object({
      ...requestBase,
      action: z.literal('wait'),
      taskId: taskIdSchema,
      timeoutMs: z.number().int().nonnegative().max(45_000).optional()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      action: z.literal('supervise'),
      mode: superviseModeSchema,
      timeoutMs: z.number().int().nonnegative().max(45_000).optional()
    })
    .strict(),
  z.object({ ...requestBase, action: z.literal('result'), taskId: taskIdSchema }).strict(),
  z.object({ ...requestBase, action: z.literal('cancel'), taskId: taskIdSchema }).strict(),
  z.object({ ...requestBase, action: z.literal('list') }).strict(),
  z.object({ ...requestBase, action: z.literal('release'), taskId: taskIdSchema }).strict()
])

export const sessionTaskCancelSchema = z
  .object({
    type: z.literal('session-task-cancel'),
    requestId: requestIdSchema
  })
  .strict()

const taskStateSchema = z.enum([
  'idle',
  'running',
  'awaiting-approval',
  'error',
  'stopped',
  'unavailable'
])

export const sessionTaskViewSchema = z
  .object({
    taskId: taskIdSchema,
    parentWorkerId: z.string().min(1).max(128),
    parentSessionId: sessionIdSchema,
    parentGeneration: generationSchema,
    workerId: z.string().min(1).max(128),
    sessionId: sessionIdSchema,
    generation: generationSchema,
    projectPath: z.string().min(1).max(4096),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    state: taskStateSchema,
    busy: z.boolean(),
    queuedCount: z.number().int().nonnegative(),
    approvals: z.number().int().nonnegative()
  })
  .strict()

const waitOutcomeSchema = z.enum(['completed', 'error', 'stopped', 'unavailable', 'timeout'])
export const sessionTaskWaitResultSchema = z
  .object({
    outcome: waitOutcomeSchema,
    task: sessionTaskViewSchema
  })
  .strict()

export const sessionTaskSuperviseResultSchema = z
  .object({
    mode: superviseModeSchema,
    outcome: z.enum(['snapshot', 'settled', 'all-settled', 'timeout', 'empty']),
    tasks: z.array(sessionTaskViewSchema).max(16),
    settledTaskIds: z.array(taskIdSchema).max(16),
    pendingTaskIds: z.array(taskIdSchema).max(16)
  })
  .strict()

export const sessionTaskCanonicalResultSchema = z
  .object({
    outcome: z.enum([
      'ready',
      'pending',
      'error',
      'stopped',
      'unavailable',
      'no-result',
      'ambiguous'
    ]),
    entryId: z.string().min(1).max(4096).optional(),
    markdown: z.string().max(32_000).optional(),
    truncated: z.boolean().optional(),
    originalLength: z.number().int().nonnegative().optional()
  })
  .strict()

export const sessionTaskResultSchema = z
  .object({
    task: sessionTaskViewSchema,
    result: sessionTaskCanonicalResultSchema
  })
  .strict()

const responseDataSchema = z.union([
  sessionTaskViewSchema,
  z.array(sessionTaskViewSchema).max(16),
  sessionTaskWaitResultSchema,
  sessionTaskSuperviseResultSchema,
  sessionTaskResultSchema,
  z.object({ released: z.literal(true) }).strict()
])

export const sessionTaskResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('session-task-response'),
      requestId: requestIdSchema,
      ok: z.literal(true),
      data: responseDataSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('session-task-response'),
      requestId: requestIdSchema,
      ok: z.literal(false),
      error: z.string().min(1).max(4096)
    })
    .strict()
])

export type SessionTaskRequest = z.infer<typeof sessionTaskRequestSchema>
export type SessionTaskCancel = z.infer<typeof sessionTaskCancelSchema>
export type SessionTaskViewWire = z.infer<typeof sessionTaskViewSchema>
export type SessionTaskWaitResultWire = z.infer<typeof sessionTaskWaitResultSchema>
export type SessionTaskSuperviseResultWire = z.infer<typeof sessionTaskSuperviseResultSchema>
export type SessionTaskResultWire = z.infer<typeof sessionTaskResultSchema>
export type SessionTaskResponse = z.infer<typeof sessionTaskResponseSchema>
export type SessionTaskResponseData = z.infer<typeof responseDataSchema>
