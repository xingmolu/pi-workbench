import { expect, it } from 'vitest'
import { formatElapsed } from './run-clock'

it('formats run time as m:ss, and h:mm:ss past an hour', () => {
  expect(formatElapsed(0)).toBe('0:00')
  expect(formatElapsed(83)).toBe('1:23')
  expect(formatElapsed(3725)).toBe('1:02:05')
})
