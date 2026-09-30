import { expect, it } from 'vitest'
import { conversationActivity } from './conversation-activity'
import type { ConversationNode } from '../../../shared/contracts'
const user: ConversationNode = { id: 'u', type: 'user', text: 'hello' }
it('covers the first-token wait and streaming reply, and stops at completion', () => {
  expect(conversationActivity([user], true, 0)).toBe('正在处理')
  expect(
    conversationActivity(
      [user, { id: 'a', type: 'assistant', markdown: 'Hello', streaming: true }],
      true,
      0
    )
  ).toBe('正在回复')
  expect(conversationActivity([user], false, 0)).toBeNull()
})
it('does not animate while waiting for approval or duplicate active work', () => {
  expect(conversationActivity([user], true, 1)).toBeNull()
  expect(
    conversationActivity(
      [user, { id: 't', type: 'think', text: 'thinking', streaming: true }],
      true,
      0
    )
  ).toBeNull()
})
