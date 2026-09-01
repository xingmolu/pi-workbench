export type FollowUpQueueSession = {
  clearQueue: () => unknown
  getFollowUpMessages: () => readonly string[]
}

/**
 * Clear Pi's queue and synchronously read back the canonical follow-up state.
 * The host uses this return value immediately instead of waiting for a queue event.
 */
export function clearFollowUpQueue(session: FollowUpQueueSession): string[] {
  session.clearQueue()
  return [...session.getFollowUpMessages()]
}
