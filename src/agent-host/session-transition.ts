import type { HostCommand } from '../shared/contracts'

export type SessionTransitionCommand = Extract<
  HostCommand,
  { type: 'project:open' | 'session:new' | 'session:open' | 'model:set' | 'prompt:send' }
>

export function usesSessionTransition(command: HostCommand): command is SessionTransitionCommand {
  return ['project:open', 'session:new', 'session:open', 'model:set', 'prompt:send'].includes(
    command.type
  )
}

export async function runSessionReplacement(operations: {
  generationBeforeReplacement: number
  invalidationBeforeReplacement: number
  replaceSession: () => Promise<{ cancelled: boolean }>
  refreshSessions: () => Promise<unknown>
  readGeneration: () => number
  readInvalidation: () => number
  recoverInvalidatedSession: () => Promise<void>
  clearSessionAfterRecoveryFailure: () => Promise<void>
  publishSnapshot: () => void
}): Promise<void> {
  try {
    const result = await operations.replaceSession()
    if (result.cancelled) return
    await operations.refreshSessions()
  } catch (error) {
    const rebound = operations.readGeneration() !== operations.generationBeforeReplacement
    const invalidated = operations.readInvalidation() !== operations.invalidationBeforeReplacement
    if (!rebound && invalidated) {
      try {
        await operations.recoverInvalidatedSession()
      } catch {
        await operations.clearSessionAfterRecoveryFailure()
      }
    }
    if (rebound || invalidated) {
      operations.publishSnapshot()
    }
    throw error
  }
}

export async function runPreparedSessionReplacement<Prepared>(operations: {
  generationBeforeReplacement: number
  prepare: () => Promise<Prepared>
  commit: (prepared: Prepared) => Promise<void>
  readGeneration: () => number
  publishSnapshot: () => void
}): Promise<void> {
  const prepared = await operations.prepare()
  try {
    await operations.commit(prepared)
  } catch (error) {
    if (operations.readGeneration() !== operations.generationBeforeReplacement) {
      operations.publishSnapshot()
    }
    throw error
  }
}
