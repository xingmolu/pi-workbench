import { describe, expect, it, vi } from 'vitest'
import { clearFollowUpQueue } from './queue-state'

describe('clearFollowUpQueue', () => {
  it('returns the canonical empty follow-up state immediately after clearing', () => {
    let followUp = ['先修复测试', '然后总结变更']
    const clearQueue = vi.fn(() => {
      const removed = followUp
      followUp = []
      return { steering: [], followUp: removed }
    })

    expect(
      clearFollowUpQueue({
        clearQueue,
        getFollowUpMessages: () => followUp
      })
    ).toEqual([])
    expect(clearQueue).toHaveBeenCalledOnce()
  })
})
