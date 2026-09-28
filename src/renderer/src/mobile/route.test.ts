import { expect, it } from 'vitest'
import { formatRoute, parseRoute } from './route'

it('round-trips a session route with the project and session file', () => {
  const route = {
    view: 'session' as const,
    workerId: 'w-1',
    cwd: '/Users/me/My Project',
    path: '/Users/me/.pi/sessions/a b#?.jsonl'
  }
  expect(parseRoute(`#${formatRoute(route)}`)).toEqual(route)
})

it('keeps old worker-only links working and treats anything else as the list', () => {
  expect(parseRoute('#/s/worker-1')).toEqual({ view: 'session', workerId: 'worker-1' })
  expect(parseRoute('')).toEqual({ view: 'list' })
  expect(parseRoute('#/')).toEqual({ view: 'list' })
  expect(parseRoute('#/s/%E0%A4%A')).toEqual({ view: 'list' })
  expect(formatRoute({ view: 'list' })).toBe('/')
})
