import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { NavigationLibrary, type NavigationLibraryOptions } from './navigation-library'
import { emptyNavigationLibrary, type NavigationLibraryState } from '../shared/navigation-library'

function fixture(overrides: Partial<NavigationLibraryOptions> = {}) {
  let saved: unknown
  const writes: NavigationLibraryState[] = []
  const options: NavigationLibraryOptions = {
    store: {
      get: () => saved,
      set: (_key, state) => {
        saved = structuredClone(state)
        writes.push(structuredClone(state))
      }
    },
    normalize: async (path) => (path === '/alias' ? '/project' : path),
    now: () => 100,
    mutationReason: () => null,
    renamedSession: vi.fn(async () => {}),
    hiddenProject: vi.fn(),
    archivedSession: vi.fn(),
    reveal: vi.fn(async () => {}),
    copyPath: vi.fn(),
    changed: vi.fn(),
    ...overrides
  }
  const library = new NavigationLibrary(options)
  return {
    library,
    options,
    writes,
    replace: (value: unknown) => {
      saved = value
    }
  }
}
describe('native-owned reversible navigation', () => {
  it('persists removal across service recreation, retains names/pins and restores canonical aliases', async () => {
    const f = fixture()
    await f.library.dispatch({ type: 'project:rename', cwd: '/alias', name: '  我的工作区  ' })
    await f.library.dispatch({ type: 'project:pin', cwd: '/project', pinned: true })
    await f.library.dispatch({ type: 'project:hide', cwd: '/project' })
    expect(f.options.hiddenProject).toHaveBeenCalledWith('/project')
    const reopened = new NavigationLibrary(f.options)
    expect(reopened.read().projects['/project']).toEqual({
      name: '我的工作区',
      pinnedAt: 100,
      hiddenAt: 100
    })
    await reopened.dispatch({ type: 'project:restore', cwd: '/alias' })
    expect(reopened.read().projects['/project']).toEqual({ name: '我的工作区', pinnedAt: 100 })
    expect(f.options.renamedSession).not.toHaveBeenCalled()
  })
  it('allows missing directories to be removed without touching filesystem contents', async () => {
    const f = fixture({
      normalize: async () => {
        throw new Error('ENOENT')
      }
    })
    await f.library.dispatch({ type: 'project:hide', cwd: '/missing' })
    expect(f.library.read().projects[resolve('/missing')].hiddenAt).toBe(100)
    expect(f.options.reveal).not.toHaveBeenCalled()
  })
  it.each(['运行中', '等待确认', '待发送消息', '正在准备会话', '有尚未确认的操作结果'])(
    'rejects removal and archive while authoritative state says %s',
    async (reason) => {
      const f = fixture({ mutationReason: () => reason })
      await expect(f.library.dispatch({ type: 'project:hide', cwd: '/project' })).rejects.toThrow(
        reason
      )
      await expect(
        f.library.dispatch({
          type: 'session:archive',
          cwd: '/project',
          path: '/sessions/a',
          title: 'A',
          archived: true
        })
      ).rejects.toThrow(reason)
      expect(f.writes).toHaveLength(0)
      expect(f.options.hiddenProject).not.toHaveBeenCalled()
      expect(f.options.archivedSession).not.toHaveBeenCalled()
    }
  )
  it('rechecks authoritative state at the persistence boundary', async () => {
    let calls = 0
    const f = fixture({ mutationReason: () => (++calls > 1 ? '运行刚刚开始' : null) })
    await expect(f.library.dispatch({ type: 'project:hide', cwd: '/project' })).rejects.toThrow(
      '运行刚刚开始'
    )
    expect(f.writes).toHaveLength(0)
  })
  it('serializes concurrent changes and increments a native revision without losing fields', async () => {
    const f = fixture()
    await Promise.all([
      f.library.dispatch({ type: 'project:rename', cwd: '/project', name: '工作区' }),
      f.library.dispatch({ type: 'project:pin', cwd: '/project', pinned: true }),
      f.library.dispatch({ type: 'layout:save', layout: { sidebarWidth: 264 } }),
      f.library.dispatch({ type: 'layout:save', layout: { workbenchWidth: 460 } })
    ])
    expect(f.library.read()).toMatchObject({
      revision: 4,
      projects: { '/project': { name: '工作区', pinnedAt: 100 } },
      layout: { sidebarWidth: 264, workbenchWidth: 460 }
    })
  })
  it('reuses actual session rename, propagates failure and does not fabricate a saved title', async () => {
    const f = fixture({
      renamedSession: vi.fn(async () => {
        throw new Error('历史文件只读')
      })
    })
    await expect(
      f.library.dispatch({
        type: 'session:rename',
        cwd: '/project',
        path: '/sessions/a',
        name: '新标题'
      })
    ).rejects.toThrow('历史文件只读')
    expect(f.writes).toHaveLength(0)
    await f.library.dispatch({ type: 'project:pin', cwd: '/project', pinned: true })
    expect(f.library.read().revision).toBe(1)
  })
  it('does not detach the foreground or announce success if persistence fails', async () => {
    const f = fixture({
      store: {
        get: () => undefined,
        set: () => {
          throw new Error('disk full')
        }
      }
    })
    await expect(f.library.dispatch({ type: 'project:hide', cwd: '/project' })).rejects.toThrow(
      'disk full'
    )
    expect(f.options.hiddenProject).not.toHaveBeenCalled()
    expect(f.options.changed).not.toHaveBeenCalled()
  })
  it('archive and undo retain pin metadata and never rewrite the actual history', async () => {
    const f = fixture()
    await f.library.dispatch({
      type: 'session:pin',
      cwd: '/project',
      path: '/sessions/a',
      title: 'A',
      pinned: true
    })
    await f.library.dispatch({
      type: 'session:archive',
      cwd: '/project',
      path: '/sessions/a',
      title: 'A',
      archived: true
    })
    expect(f.options.archivedSession).toHaveBeenCalledWith('/project', '/sessions/a')
    await f.library.dispatch({
      type: 'session:archive',
      cwd: '/project',
      path: '/sessions/a',
      title: 'A',
      archived: false
    })
    expect(f.library.read().sessions['/sessions/a']).toEqual({
      cwd: '/project',
      title: 'A',
      pinnedAt: 100
    })
    expect(f.options.renamedSession).not.toHaveBeenCalled()
  })
  it('successful explicit open restores only its project and session', () => {
    const f = fixture()
    f.replace({
      ...emptyNavigationLibrary(),
      projects: { '/a': { hiddenAt: 1 }, '/b': { hiddenAt: 1 } },
      sessions: { '/s/a': { cwd: '/a', archivedAt: 1 }, '/s/b': { cwd: '/b', archivedAt: 1 } }
    })
    f.library.restoreAfterOpen('/a', '/s/a')
    expect(f.library.read()).toMatchObject({
      revision: 1,
      projects: { '/a': {}, '/b': { hiddenAt: 1 } },
      sessions: { '/s/a': { cwd: '/a' }, '/s/b': { archivedAt: 1 } }
    })
  })
  it('fails closed on corrupt preferences and rejects malformed commands', async () => {
    const f = fixture()
    f.replace({ version: 999 })
    expect(() => f.library.read()).toThrow('原数据未修改')
    expect(() => f.library.dispatch({ type: 'project:delete', cwd: '/project' })).toThrow()
    expect(() =>
      f.library.dispatch({ type: 'layout:save', layout: { sidebarWidth: 99999 } })
    ).toThrow()
    expect(f.writes).toHaveLength(0)
    f.replace(undefined)
    await expect(f.library.dispatch({ type: 'project:hide', cwd: 'relative' })).rejects.toThrow(
      '绝对路径'
    )
  })
})
