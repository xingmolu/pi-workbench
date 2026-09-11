export type SessionForkTarget = { sessionId: string; generation: number; entryId: string }
export type SessionForkState = SessionForkTarget & { eligible: boolean; reason: string | null }

export async function refreshForkFailure(operations: {
  refreshAuth: () => Promise<unknown>
  refreshSessions: () => Promise<unknown>
  publishSnapshot: () => void
}): Promise<void> {
  // Every projection gets an attempt even if another one is unavailable.
  try {
    await operations.refreshAuth()
  } catch {
    /* Preserve fork failure. */
  }
  try {
    await operations.refreshSessions()
  } catch {
    /* Preserve fork failure. */
  }
  operations.publishSnapshot()
}

function requireTarget(expected: SessionForkTarget, actual: SessionForkState | null): void {
  if (
    !actual ||
    expected.sessionId !== actual.sessionId ||
    expected.generation !== actual.generation ||
    expected.entryId !== actual.entryId
  )
    throw new Error('会话已变化，请重新打开分叉确认')
  if (!actual.eligible) throw new Error(actual.reason ?? '当前会话暂时不能分叉')
}

/** Called inside the shared mutation queue; preparation may yield, so revalidate afterwards. */
export async function forkCurrentSession(
  target: SessionForkTarget,
  operations: {
    readTarget: (entryId: string) => SessionForkState | null
    prepare: () => Promise<void>
    fork: (entryId: string) => Promise<{ cancelled: boolean }>
    refreshAfterFailure: () => Promise<unknown>
  }
): Promise<{ cancelled: boolean }> {
  requireTarget(target, operations.readTarget(target.entryId))
  try {
    await operations.prepare()
  } catch (cause) {
    try {
      await operations.refreshAfterFailure()
    } catch {
      /* Keep the preparation failure; SDK fork has not been invoked. */
    }
    throw new Error('分叉尚未开始：准备会话失败。请核对当前会话和列表后重新打开分叉确认。', {
      cause
    })
  }
  requireTarget(target, operations.readTarget(target.entryId))
  try {
    return await operations.fork(target.entryId)
  } catch (cause) {
    // SDK child creation precedes teardown. A rejected operation can leave a child.
    try {
      await operations.refreshAfterFailure()
    } catch {
      /* Keep original failure. */
    }
    throw new Error('分叉未完成；可能已创建新会话。请核对当前会话和列表，不要直接重试。', { cause })
  }
}

export function assertPromptIdentity(
  expected: { sessionId: string; generation: number },
  actual: { sessionId: string | null; generation: number }
): void {
  if (expected.sessionId !== actual.sessionId || expected.generation !== actual.generation)
    throw new Error('会话已切换，未发送此草稿；请返回原会话后重新发送')
}
