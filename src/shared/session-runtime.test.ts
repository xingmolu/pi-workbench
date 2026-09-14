import { expect, it } from 'vitest'
import { sameSelectedScope } from './session-runtime'

it('distinguishes selection visits even for the same worker', () => {
  expect(
    sameSelectedScope({ workerId: 'a', selectionEpoch: 1 }, { workerId: 'a', selectionEpoch: 2 })
  ).toBe(false)
  expect(
    sameSelectedScope({ workerId: 'a', selectionEpoch: 2 }, { workerId: 'a', selectionEpoch: 2 })
  ).toBe(true)
  expect(sameSelectedScope(null, null)).toBe(true)
})
