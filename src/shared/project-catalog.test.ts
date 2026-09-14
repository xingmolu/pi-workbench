import { expect, it } from 'vitest'
import { hostCommandSchema, hostResultSchema } from './schemas'
import { expectedHostResultKind } from './command-result'
import { projectNavigationReason } from './project-catalog'
import { EMPTY_SNAPSHOT } from '../renderer/src/store/pi-store'

it('allows busy resident navigation but retains editing and login guards', () => {
  const state = { ...EMPTY_SNAPSHOT, ready: true, busy: true, queuedCount: 1,
    desktopScope: { workerId: 'a', selectionEpoch: 1 } }
  expect(projectNavigationReason(state)).toBeNull()
  expect(projectNavigationReason({ ...state, ready: false })).not.toBeNull()
  expect(projectNavigationReason({ ...state, ready: false }, true)).toBeNull()
  expect(projectNavigationReason({ ...state, edit: { entryId: null, leafId: null, reason: null, pending: true } })).not.toBeNull()
  expect(projectNavigationReason({ ...state, login: { phase: 'waiting' } })).not.toBeNull()
})

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
