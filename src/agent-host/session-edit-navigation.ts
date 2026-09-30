import type { AgentSession } from '@earendil-works/pi-coding-agent'

/** Public SDK no-summary navigation with the user-leaf early-noop corrected.
 * Revalidation belongs to the host: hooks may change identity, config or history.
 * Branch selection is not persisted; an extension label is a real append.
 */
export async function navigateToEditedUserParent(
  session: AgentSession,
  userId: string,
  options: {
    signal: AbortSignal
    revalidate: (phase: 'before' | 'after', leafId: string | null) => void
    onMutation?: () => void
  }
): Promise<{ cancelled: boolean; mutated: boolean }> {
  const manager = session.sessionManager
  const user = manager.getEntry(userId)
  if (!user || user.type !== 'message' || user.message.role !== 'user')
    throw new Error('原问题已变化，请重新打开编辑')
  const oldLeafId = manager.getLeafId()
  const { collectEntriesForBranchSummary } = await import('@earendil-works/pi-coding-agent')
  options.revalidate('before', oldLeafId)
  const { entries, commonAncestorId } = collectEntriesForBranchSummary(manager, oldLeafId, userId)
  const result = (await session.extensionRunner.emit({
    type: 'session_before_tree',
    preparation: {
      targetId: userId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize: entries,
      userWantsSummary: false,
      customInstructions: undefined,
      replaceInstructions: undefined,
      label: undefined
    },
    signal: options.signal
  })) as { cancel?: boolean; label?: string } | undefined
  if (result?.cancel || options.signal.aborted) return { cancelled: true, mutated: false }
  options.revalidate('before', oldLeafId)
  options.onMutation?.()
  if (user.parentId === null) manager.resetLeaf()
  else manager.branch(user.parentId)
  if (result?.label) manager.appendLabelChange(userId, result.label)
  session.refreshContext()
  const newLeafId = manager.getLeafId()
  await session.extensionRunner.emit({
    type: 'session_tree',
    newLeafId,
    oldLeafId,
    summaryEntry: undefined,
    fromExtension: undefined
  })
  options.revalidate('after', newLeafId)
  if (options.signal.aborted) return { cancelled: true, mutated: true }
  return { cancelled: false, mutated: true }
}
