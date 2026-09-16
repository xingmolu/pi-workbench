import { describe, expect, it } from 'vitest'
import {
  buildMobileHomeGroups,
  filterMobileHomeGroups,
  formatMobileTime,
  stripIsoTimestamp
} from './mobile-list'

describe('mobile list presentation', () => {
  const now = new Date('2026-09-16T10:07:00.000Z')

  it('formats short local times and never dumps ISO-Z', () => {
    expect(formatMobileTime('2026-09-16T02:40:19.201Z', now, 'UTC')).toBe('02:40')
    expect(formatMobileTime('2026-09-15T14:40:19.201Z', now, 'UTC')).toBe('昨天 14:40')
    expect(formatMobileTime('2026-09-11T09:46:03.573Z', now, 'UTC')).toBe('09-11 09:46')
    expect(formatMobileTime('2025-12-30T08:00:00.000Z', now, 'UTC')).toBe('2025-12-30')
    for (const value of ['2026-09-15T14:40:19.201Z', 'today', 'not-a-date', '']) {
      const label = formatMobileTime(value, now, 'UTC')
      expect(label).not.toMatch(/T/)
      expect(label).not.toMatch(/Z/)
    }
  })

  it('strips ISO timestamps glued onto session titles', () => {
    expect(stripIsoTimestamp('你有 ego skill 吗2026-09-15T14:40:19.201Z')).toBe('你有 ego skill 吗')
    expect(stripIsoTimestamp('普通标题')).toBe('普通标题')
  })

  it('groups catalog sessions under the project with trailing time labels', () => {
    const groups = buildMobileHomeGroups(
      [
        {
          workerId: 'w1',
          cwd: '/Users/me/work/finance-app',
          sessionPath: '/s.jsonl',
          sessionId: 'sess-1',
          generation: 1,
          status: 'running',
          selected: true,
          title: '你有 ego skill 吗2026-09-15T14:40:19.201Z'
        }
      ],
      [
        {
          path: '/Users/me/work/finance-app',
          name: 'finance-app',
          sessions: [
            {
              path: '/s.jsonl',
              title: '你有 ego skill 吗2026-09-15T14:40:19.201Z',
              modified: '2026-09-15T14:40:19.201Z',
              status: 'idle'
            }
          ]
        }
      ],
      now,
      'UTC'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('finance-app')
    expect(groups[0]?.sessions).toHaveLength(1)
    expect(groups[0]?.sessions[0]?.title).toBe('你有 ego skill 吗')
    expect(groups[0]?.sessions[0]?.timeLabel).toBe('昨天 14:40')
    expect(groups[0]?.sessions[0]?.status).toBe('running')
    expect(groups[0]?.sessions[0]?.timeLabel).not.toMatch(/T|Z/)
    expect(filterMobileHomeGroups(groups, 'ego')[0]?.sessions).toHaveLength(1)
    expect(filterMobileHomeGroups(groups, 'nope')).toEqual([])
  })
})
