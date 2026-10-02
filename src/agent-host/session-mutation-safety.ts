import { t } from '../shared/i18n'
export class SessionRuntimeUnsafeError extends Error {}

export class SessionMutationGuard {
  private failure: SessionRuntimeUnsafeError | undefined

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure
    try {
      return await operation()
    } catch (error) {
      if (error instanceof SessionRuntimeUnsafeError) this.failure = error
      throw error
    }
  }
}

type ModelMutationSession = {
  readonly model: unknown
  readonly thinkingLevel: unknown
  sessionManager: {
    getLeafId(): string | null
    getEntries(): readonly { id: string }[]
  }
}

function snapshot(session: ModelMutationSession) {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    leaf: session.sessionManager.getLeafId(),
    entryIds: session.sessionManager.getEntries().map((entry) => entry.id)
  }
}

function unsafeModelMutation(cause: unknown): SessionRuntimeUnsafeError {
  return new SessionRuntimeUnsafeError(t('模型更新未完成，运行时已停止；请重新连接'), { cause })
}

/** Only a rejected mutation with provably unchanged public state is recoverable. */
export async function guardModelMutation<T>(
  session: ModelMutationSession,
  operation: () => Promise<T>
): Promise<T> {
  let before: ReturnType<typeof snapshot>
  try {
    before = snapshot(session)
  } catch (error) {
    throw unsafeModelMutation(error)
  }
  try {
    return await operation()
  } catch (error) {
    let after: ReturnType<typeof snapshot>
    try {
      after = snapshot(session)
    } catch {
      throw unsafeModelMutation(error)
    }
    if (
      before.model !== after.model ||
      before.thinkingLevel !== after.thinkingLevel ||
      before.leaf !== after.leaf ||
      before.entryIds.length !== after.entryIds.length ||
      before.entryIds.some((id, index) => id !== after.entryIds[index])
    )
      throw unsafeModelMutation(error)
    throw error
  }
}
