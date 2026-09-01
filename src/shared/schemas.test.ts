import { describe, expect, it } from 'vitest'
import { hostCommandSchema, hostRequestSchema } from './schemas'

describe('queue:clear schema', () => {
  it('accepts the typed command and request', () => {
    expect(hostCommandSchema.parse({ type: 'queue:clear' })).toEqual({ type: 'queue:clear' })
    expect(hostRequestSchema.parse({ type: 'queue:clear', requestId: 'request-1' })).toEqual({
      type: 'queue:clear',
      requestId: 'request-1'
    })
  })

  it('rejects untyped queue payloads', () => {
    expect(hostCommandSchema.safeParse({ type: 'queue:clear', index: 0 }).success).toBe(false)
  })
})
