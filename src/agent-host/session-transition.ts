import type { HostCommand } from '../shared/contracts'

export type SessionTransitionCommand = Extract<
  HostCommand,
  {
    type:
      | 'project:open'
      | 'project:navigate'
      | 'session:new'
      | 'session:open'
      | 'session:fork'
      | 'message:feedback'
      | 'session:edit:prepare'
      | 'session:edit:send'
      | 'session:rename'
      | 'model:set'
      | 'prompt:send'
      | 'attachment:prompt'
      | 'account:login'
      | 'account:alias:add'
      | 'endpoint:save'
  }
>

export function usesSessionTransition(command: HostCommand): command is SessionTransitionCommand {
  return [
    'project:open',
    'project:navigate',
    'session:new',
    'session:open',
    'session:fork',
    'message:feedback',
    'session:edit:prepare',
    'session:edit:send',
    'session:rename',
    'model:set',
    'prompt:send',
    'attachment:prompt',
    'account:login',
    'account:alias:add',
    'endpoint:save'
  ].includes(command.type)
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
}): Promise<{ cancelled: boolean }> {
  try {
    const result = await operations.replaceSession()
    if (result.cancelled) return { cancelled: true }
    await operations.refreshSessions()
    return { cancelled: false }
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
