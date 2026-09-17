import { expect, it } from 'vitest'
import { sidebarPathHint, sidebarSessions } from './sidebar-presentation'
import type { LiveSessionRow } from './live-projects'

const rows: LiveSessionRow[] = Array.from({ length: 12 }, (_, i) => ({
  id: String(i),
  path: `/sessions/${i}`,
  title: `会话 ${i}`,
  modified: '',
  messageCount: 1,
  active: false,
  status: 'idle'
}))

it('distinguishes same-name projects without repeating long common prefixes', () => {
  const peers = ['/work/client/app', '/archive/client/app']
  expect(sidebarPathHint(peers[0], peers)).toBe('work/client/app')
  expect(sidebarPathHint('/work/other/app', peers)).toBe('other/app')
})

it('folds history to five without mutating catalog or losing expanded results', () => {
  expect(sidebarSessions(rows, false)).toEqual(rows.slice(0, 5))
  expect(sidebarSessions(rows, true)).toEqual(rows)
  expect(rows).toHaveLength(12)
})

it('keeps selected, running and approval residents visible in original order', () => {
  const current = rows.map((row, i) => ({
    ...row,
    active: i === 8,
    ...(i === 9 ? { workerId: 'a', status: 'running' as const } : {}),
    ...(i === 10 ? { workerId: 'b', status: 'awaiting-approval' as const } : {})
  }))
  expect(sidebarSessions(current, false).map((row) => row.id)).toEqual([
    '0',
    '1',
    '2',
    '3',
    '4',
    '8',
    '9',
    '10'
  ])
})

it('keeps an idle SessionTask child and its parent visible outside the recent window', () => {
  const current = rows.map((row, i) => ({
    ...row,
    ...(i === 8 ? { workerId: 'parent' } : {}),
    ...(i === 9
      ? {
          workerId: 'child',
          sessionTask: {
            taskId: 'task-1',
            parentWorkerId: 'parent',
            createdAt: 1
          }
        }
      : {})
  }))
  expect(sidebarSessions(current, false).map((row) => row.id)).toEqual([
    '0',
    '1',
    '2',
    '3',
    '4',
    '8',
    '9'
  ])
})

it('keeps resident failures visible but does not expand every historical error', () => {
  const current = rows.map((row, i) => ({
    ...row,
    status: 'error' as const,
    ...(i === 11 ? { workerId: 'failed' } : {})
  }))
  expect(sidebarSessions(current, false)).toHaveLength(6)
})
