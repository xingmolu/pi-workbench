import { describe, expect, it } from 'vitest'
import {
  belongsToProject,
  filterProjectSessions,
  assertProjectSession,
  requireProjectSessionPath
} from './project-sessions'

describe('canonical project membership', () => {
  it.each([
    ['/fixture/a-b', '/fixture/a-b', true],
    ['/fixture/a/b', '/fixture/a-b', false],
    ['/fixture/a/../a-b/', '/fixture/a-b', true],
    [undefined, '/fixture/a-b', false],
    ['', '/fixture/a-b', false],
    ['fixture/a-b', '/fixture/a-b', false],
    ['/fixture/a-b', 'fixture/a-b', false]
  ])('compares %s with %s without cwd fallback', (session, project, expected) => {
    expect(belongsToProject(session, project)).toBe(expected)
  })
  it('preserves the SDK order and original objects', () => {
    const newest = { cwd: '/a', path: '/new' }
    const older = { cwd: '/a', path: '/old' }
    const result = filterProjectSessions([{ cwd: '/b' }, newest, {}, older], '/a')
    expect(result).toEqual([newest, older])
    expect(result[0]).toBe(newest)
    expect(filterProjectSessions([], '/a')).toEqual([])
    expect(filterProjectSessions([{ cwd: '/b' }], '/a')).toEqual([])
  })
  it('rejects an explicit foreign or nonexact path', () => {
    const sessions = [
      { cwd: '/a', path: '/a.jsonl' },
      { cwd: '/b', path: '/b.jsonl' }
    ]
    expect(() => requireProjectSessionPath(sessions, '/a', '/a.jsonl')).not.toThrow()
    expect(() => requireProjectSessionPath(sessions, '/a', '/b.jsonl')).toThrow(
      '会话不属于当前工作区'
    )
    expect(() => requireProjectSessionPath(sessions, '/a', '/x/../a.jsonl')).toThrow()
  })
  it('guards both actual manager cwd and factory cwd before creating services', () => {
    expect(() => assertProjectSession({ getCwd: () => '/a' }, '/a', '/a')).not.toThrow()
    expect(() => assertProjectSession({ getCwd: () => '/b' }, '/a', '/a')).toThrow(
      '会话不属于当前工作区'
    )
    expect(() => assertProjectSession({ getCwd: () => '/a' }, '/a', '/b')).toThrow(
      '会话不属于当前工作区'
    )
  })
})
