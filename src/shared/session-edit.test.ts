import { expect, it } from 'vitest'
import { hostCommandSchema, hostResultSchema } from './schemas'
import { expectedHostResultKind } from './command-result'
const token = '60627dcd-1217-41a3-b9ef-0df68ebfe2dc'
it('accepts only bounded edit capabilities through the typed bridge', () => {
  const command = {
    type: 'session:edit:prepare',
    sessionId: 'session',
    generation: 1,
    entryId: 'user',
    leafId: 'leaf'
  }
  expect(hostCommandSchema.safeParse(command).success).toBe(true)
  expect(hostCommandSchema.safeParse({ ...command, path: '/private' }).success).toBe(false)
  expect(
    hostCommandSchema.safeParse({ type: 'session:edit:send', token, submissionId: token, text: '' })
      .success
  ).toBe(true)
  expect(
    hostCommandSchema.safeParse({
      type: 'session:edit:send',
      token,
      submissionId: token,
      text: '汉'.repeat(400000)
    }).success
  ).toBe(false)
  expect(expectedHostResultKind(command as never)).toBe('session-edit')
  expect(
    hostResultSchema.safeParse({ kind: 'session-edit', result: { type: 'cancelled' } }).success
  ).toBe(true)
})
