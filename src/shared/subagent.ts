import { z } from 'zod'

/** Display data supplied by runtime adapters; tool completion is independent of child completion. */
export const subagentSummarySchema = z
  .object({
    id: z.string().min(1).max(256),
    title: z.string().max(200),
    revision: z.number().int().nonnegative().optional(),
    prompt: z.string().max(8000).optional(),
    state: z.enum([
      'queued',
      'running',
      'awaiting-approval',
      'idle',
      'success',
      'error',
      'stopped',
      'unavailable'
    ]),
    workerId: z.string().max(128).optional(),
    sessionId: z.string().max(1024).optional(),
    generation: z.number().int().nonnegative().optional(),
    startedAt: z.number().finite().optional(),
    activity: z.string().max(240).optional(),
    recentTools: z
      .array(z.object({ title: z.string().max(240), status: z.string().max(32) }).strict())
      .max(3)
      .optional(),
    output: z.string().max(32000).optional(),
    truncated: z.boolean().optional(),
    model: z.string().max(200).optional(),
    tokens: z.number().nonnegative().optional()
  })
  .strict()
export type SubagentSummary = z.infer<typeof subagentSummarySchema>

export const subagentOperationSchema = z
  .object({
    operation: z.enum(['spawn', 'observe', 'collect', 'send', 'cancel', 'release']),
    children: z.array(subagentSummarySchema).max(16)
  })
  .strict()
export type SubagentOperation = z.infer<typeof subagentOperationSchema>

/** Native children retain their parent's worker even while the parent waits for another prompt. */
export function hasActiveNativeSubagents(snapshot: import('./contracts').AgentSnapshot): boolean {
  if (snapshot.runtime?.subagents !== 'native') return false
  return snapshot.nodes.some(
    (node) =>
      node.type === 'tool' &&
      node.subagent?.children.some((child) =>
        ['queued', 'running', 'awaiting-approval'].includes(child.state)
      )
  )
}
