import { expect, it } from 'vitest'
import { emptyNavigationLibrary } from '../../../shared/navigation-library'
import { presentNavigationProjects } from './navigation-presentation'
import { sidebarSessions } from './sidebar-presentation'
import type { LiveProject, LiveSessionRow } from './live-projects'
const row = (path: string, extra: Partial<LiveSessionRow> = {}): LiveSessionRow => ({
  id: path,
  path,
  title: path,
  modified: '',
  messageCount: 0,
  active: false,
  status: 'idle',
  ...extra
})
const project = (path: string, sessions: LiveSessionRow[]): LiveProject => ({
  path,
  name: 'name',
  sessions,
  totalSessions: sessions.length,
  nextOffset: null
})
it('applies removal after live worker merge so idle workers cannot resurrect a hidden project', () => {
  const lib = emptyNavigationLibrary()
  lib.projects['/a'] = { hiddenAt: 1 }
  expect(presentNavigationProjects([project('/a', [row('/s', { workerId: 'w' })])], lib)).toEqual(
    []
  )
  expect(
    presentNavigationProjects(
      [project('/a', [row('/s', { workerId: 'w', status: 'awaiting-approval' })])],
      lib
    )
  ).toHaveLength(1)
})
it('keeps pins visible beyond recent history and preserves relative parent/child placement', () => {
  const lib = emptyNavigationLibrary()
  lib.sessions['/pin'] = { cwd: '/a', pinnedAt: 1 }
  lib.sessions['/archived'] = { cwd: '/a', archivedAt: 2 }
  lib.projects['/a'] = { name: '我的项目', pinnedAt: 1 }
  const list = [
    ...Array.from({ length: 10 }, (_, i) => row('/s' + i)),
    row('/pin'),
    row('/archived')
  ]
  const shown = presentNavigationProjects([project('/b', []), project('/a', list)], lib)
  expect(shown[0].name).toBe('我的项目')
  expect(shown[0].sessions[0].path).toBe('/pin')
  expect(sidebarSessions(shown[0].sessions, false).some((item) => item.path === '/pin')).toBe(true)
  expect(shown[0].sessions.some((item) => item.path === '/archived')).toBe(false)
})
