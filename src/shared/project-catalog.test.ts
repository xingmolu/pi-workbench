import { expect, it } from 'vitest'
import { hostCommandSchema, hostResultSchema } from './schemas'
import { expectedHostResultKind } from './command-result'

it('accepts a single scoped project and session navigation intent and rejects extras', () => {
  const command = {
    type: 'project:navigate' as const,
    cwd: '/b',
    sessionPath: '/sessions/b.jsonl',
    sessionId: 'a',
    generation: 2
  }
  expect(hostCommandSchema.safeParse(command).success).toBe(true)
  expect(expectedHostResultKind(command)).toBe('snapshot')
  expect(hostCommandSchema.safeParse({ ...command, generation: -1 }).success).toBe(false)
  expect(hostCommandSchema.safeParse({ ...command, prompt: 'execute me' }).success).toBe(false)
  expect(
    hostResultSchema.safeParse({
      kind: 'project-catalog',
      catalog: { projects: [], totalProjects: 0, truncated: false, cause: 'secret' }
    }).success
  ).toBe(false)
})
