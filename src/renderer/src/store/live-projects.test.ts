import { expect, it } from 'vitest'
import { liveProjects } from './live-projects'
import { EMPTY_SNAPSHOT } from './pi-store'
import type { LiveSessionSummary } from '../../../shared/session-runtime'
import type { ProjectCatalog } from '../../../shared/project-catalog'

const resident = (workerId: string, sessionPath: string | null, selected = false): LiveSessionSummary => ({
  workerId, cwd: '/project', sessionPath, sessionId: workerId, generation: 2,
  status: 'running', selected, title: `会话 ${workerId}`
})
const catalog: ProjectCatalog = { projects: [{
  path: '/project', name: 'project', totalSessions: 1, nextOffset: null,
  sessions: [{ id: 'a', messageCount: 1, path: '/a.jsonl', title: 'A', modified: '2026-09-14', active: true, status: 'idle' }]
}], totalProjects: 1, truncated: false }

it('merges both running residents and makes selection independent of running state', () => {
  const result = liveProjects(catalog, EMPTY_SNAPSHOT, [resident('a', '/a.jsonl'), resident('b', '/b.jsonl', true)])
  expect(result[0].sessions.map(s => [s.workerId, s.status, s.active])).toEqual([
    ['b', 'running', true], ['a', 'running', false]
  ])
})

it('includes unsaved residents without inventing a canonical path and keeps their worker identity', () => {
  const result = liveProjects(null, EMPTY_SNAPSHOT, [resident('a', null), resident('b', null, true)])
  expect(result).toHaveLength(1)
  expect(result[0].sessions).toHaveLength(2)
  expect(result[0].sessions.every(s => s.path === null)).toBe(true)
  expect(new Set(result[0].sessions.map(s => s.workerId)).size).toBe(2)
})

it('does not mark historical catalog rows active in a different selected project', () => {
  const result = liveProjects(catalog, { ...EMPTY_SNAPSHOT, project: { path: '/elsewhere', name: 'Other' } }, [])
  expect(result[0].sessions[0].active).toBe(false)
})
