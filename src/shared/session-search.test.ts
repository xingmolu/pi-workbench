import { expect, it } from 'vitest'
import { hostCommandSchema, hostRequestSchema, hostResultSchema } from './schemas'

it('accepts bounded search but keeps trusted recent paths and transcript out of renderer commands/results', () => {
  for (const type of ['session:search', 'project:search']) {
    const command = { type, query: '中文', limit: 50 }
    expect(hostCommandSchema.safeParse(command).success).toBe(true)
    for (const change of [
      { query: 'x'.repeat(201) },
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { recentPaths: ['/private'] }
    ])
      expect(hostCommandSchema.safeParse({ ...command, ...change }).success).toBe(false)
    expect(
      hostRequestSchema.safeParse({ ...command, requestId: '1', recentPaths: ['/trusted'] }).success
    ).toBe(true)
  }
  const result = {
    kind: 'session-search',
    result: { items: [], total: 0, truncated: false, skippedDirectories: 0, skippedEntries: 0 }
  }
  expect(hostResultSchema.safeParse(result).success).toBe(true)
  expect(hostResultSchema.safeParse({ ...result, transcript: 'private' }).success).toBe(false)
})
