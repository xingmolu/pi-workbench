import { expect, it } from 'vitest'
import { liveProjects } from './live-projects'
import { EMPTY_SNAPSHOT } from './pi-store'
import type { LiveSessionSummary } from '../../../shared/session-runtime'
import type { ProjectCatalog } from '../../../shared/project-catalog'

const resident = (
  workerId: string,
  sessionPath: string | null,
  selected = false,
  sessionTask?: LiveSessionSummary['sessionTask']
): LiveSessionSummary => ({
  workerId,
  cwd: '/project',
  sessionPath,
  sessionId: workerId,
  generation: 2,
  status: 'running',
  selected,
  title: `会话 ${workerId}`,
  ...(sessionTask ? { sessionTask } : {})
})
const catalog: ProjectCatalog = {
  projects: [
    {
      path: '/project',
      name: 'project',
      totalSessions: 1,
      nextOffset: null,
      sessions: [
        {
          id: 'a',
          messageCount: 1,
          path: '/a.jsonl',
          title: 'A',
          modified: '2026-09-14',
          active: true,
          status: 'idle'
        }
      ]
    }
  ],
  totalProjects: 1,
  truncated: false
}

it('merges both running residents and makes selection independent of running state', () => {
  const result = liveProjects(catalog, EMPTY_SNAPSHOT, [
    resident('a', '/a.jsonl'),
    resident('b', '/b.jsonl', true)
  ])
  expect(result[0].sessions.map((s) => [s.workerId, s.status, s.active])).toEqual([
    ['b', 'running', true],
    ['a', 'running', false]
  ])
})

it('includes unsaved residents without inventing a canonical path and keeps their worker identity', () => {
  const result = liveProjects(null, EMPTY_SNAPSHOT, [
    resident('a', null),
    resident('b', null, true)
  ])
  expect(result).toHaveLength(1)
  expect(result[0].sessions).toHaveLength(2)
  expect(result[0].sessions.every((s) => s.path === null)).toBe(true)
  expect(new Set(result[0].sessions.map((s) => s.workerId)).size).toBe(2)
})

it('orders SessionTask children directly below their parent in delegation order', () => {
  const relation = (taskId: string, createdAt: number): LiveSessionSummary['sessionTask'] => ({
    taskId,
    parentWorkerId: 'parent',
    parentSessionId: 'parent-session',
    parentGeneration: 4,
    createdAt
  })
  const result = liveProjects(null, EMPTY_SNAPSHOT, [
    resident('child-b', null, false, relation('task-b', 20)),
    resident('other', null),
    resident('parent', null, true),
    resident('child-a', null, false, relation('task-a', 10))
  ])

  expect(result[0].sessions.map((session) => session.workerId)).toEqual([
    'parent',
    'child-a',
    'child-b',
    'other'
  ])
  expect(result[0].sessions[1].sessionTask?.taskId).toBe('task-a')
})

it('does not mark historical catalog rows active in a different selected project', () => {
  const result = liveProjects(
    catalog,
    { ...EMPTY_SNAPSHOT, project: { path: '/elsewhere', name: 'Other' } },
    []
  )
  expect(result[0].sessions[0].active).toBe(false)
})
