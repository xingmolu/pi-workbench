import { expect, it } from 'vitest'
import { hostCommandSchema } from './schemas'
import { usesSessionTransition } from '../agent-host/session-transition'

it('accepts strictly scoped local feedback and serializes it with session changes', () => {
  const command = {
    type: 'message:feedback',
    sessionId: 's',
    generation: 1,
    entryId: 'a',
    value: 'up'
  }
  const parsed = hostCommandSchema.safeParse(command)
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(usesSessionTransition(parsed.data)).toBe(true)
  for (const bad of [{ value: 'like' }, { generation: -1 }, { entryId: '' }, { vendor: true }])
    expect(hostCommandSchema.safeParse({ ...command, ...bad }).success).toBe(false)
})
