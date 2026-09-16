import { describe, expect, it } from 'vitest'
import { renameSession, type SessionRenameTarget } from './session-rename'
import { SerialExecutor } from './serial-executor'
import { SessionPersistenceGuard } from './session-rename'
import { SessionRuntimeUnsafeError } from './session-mutation-safety'

const request = { sessionId: 'session-1', generation: 4, name: '  新名字 😀  ' }
const target: SessionRenameTarget = {
  sessionId: 'session-1',
  generation: 4,
  persisted: true,
  busy: false,
  promptPending: false,
  currentName: '旧名字'
}

describe('renameSession', () => {
  it('preserves rename error copy as a specialization of the shared fatal gate', async () => {
    const guard = new SessionPersistenceGuard()
    const rejected = guard.run(() =>
      renameSession(request, target, {
        setSessionName: () => {
          throw new Error('private disk detail')
        },
        refreshSessions: async () => true
      })
    )
    await expect(rejected).rejects.toBeInstanceOf(SessionRuntimeUnsafeError)
    await expect(rejected).rejects.toThrow('会话名称保存失败，运行时已停止；请重新连接后重试')
    await expect(guard.run(async () => 'blocked')).rejects.toBeInstanceOf(SessionRuntimeUnsafeError)
  })

  it('does not latch ordinary parameter or network failures', async () => {
    const guard = new SessionPersistenceGuard()
    await expect(
      guard.run(() =>
        renameSession({ ...request, name: ' ' }, target, {
          setSessionName: () => {},
          refreshSessions: async () => true
        })
      )
    ).rejects.toThrow('名称不能为空')
    await expect(
      guard.run(async () => {
        throw new Error('network unavailable')
      })
    ).rejects.toThrow('network unavailable')
    await expect(guard.run(async () => 'usable')).resolves.toBe('usable')
  })

  it('blocks reuse of a partially mutated name until the host reconnects', async () => {
    const guard = new SessionPersistenceGuard()
    let currentName = '旧名字'
    let diskName = '旧名字'
    let writes = 0
    const operations = {
      setSessionName: (name: string) => {
        currentName = name
        if (++writes === 1) throw new Error('disk full')
        diskName = name
      },
      refreshSessions: async () => true
    }
    await expect(
      guard.run(() => renameSession(request, { ...target, currentName }, operations))
    ).rejects.toThrow('请重新连接')
    await expect(
      guard.run(() => renameSession(request, { ...target, currentName }, operations))
    ).rejects.toThrow('请重新连接')
    expect(diskName).toBe('旧名字')
    expect(writes).toBe(1)
  })

  it('marks write failure as fatal instead of allowing further runtime use', async () => {
    await expect(
      renameSession(request, target, {
        setSessionName: () => {
          throw new Error('disk full')
        },
        refreshSessions: async () => true
      })
    ).rejects.toThrow('请重新连接')
  })
  it('writes the normalized name once and refreshes the captured generation', async () => {
    const writes: string[] = []
    const refreshed: number[] = []
    await renameSession(request, target, {
      setSessionName: (name) => {
        writes.push(name)
      },
      refreshSessions: async (generation) => {
        refreshed.push(generation)
        return true
      }
    })
    expect(writes).toEqual(['新名字 😀'])
    expect(refreshed).toEqual([4])
  })

  it.each([
    null,
    { ...target, sessionId: 'session-2' },
    { ...target, generation: 5 },
    { ...target, persisted: false },
    { ...target, busy: true },
    { ...target, promptPending: true }
  ])('does not mutate an unavailable target %j', async (current) => {
    const writes: string[] = []
    let refreshed = false
    await expect(
      renameSession(request, current, {
        setSessionName: (name) => {
          writes.push(name)
        },
        refreshSessions: async () => {
          refreshed = true
          return true
        }
      })
    ).rejects.toThrow()
    expect(writes).toEqual([])
    expect(refreshed).toBe(false)
  })

  it('validates the name before considering the target', async () => {
    await expect(
      renameSession({ ...request, name: ' ' }, null, {
        setSessionName: () => {
          throw new Error('must not write')
        },
        refreshSessions: async () => {
          throw new Error('must not refresh')
        }
      })
    ).rejects.toThrow('名称不能为空')
  })

  it('does not append another canonical entry for an unchanged normalized name', async () => {
    await renameSession(
      request,
      { ...target, currentName: ' 新名字 😀 ' },
      {
        setSessionName: () => {
          throw new Error('must not write')
        },
        refreshSessions: async () => {
          throw new Error('must not refresh')
        }
      }
    )
  })

  it('propagates SDK write failure without refreshing', async () => {
    await expect(
      renameSession(request, target, {
        setSessionName: () => {
          throw new Error('disk full')
        },
        refreshSessions: async () => {
          throw new Error('must not refresh')
        }
      })
    ).rejects.toThrow('请重新连接')
  })

  it('evaluates the target inside the queue after an earlier replacement', async () => {
    const executor = new SerialExecutor()
    let current = target
    const replacement = executor.run(async () => {
      current = { ...target, generation: 5 }
    })
    const rename = executor.run(() =>
      renameSession(request, current, {
        setSessionName: () => {
          throw new Error('must not write')
        },
        refreshSessions: async () => true
      })
    )
    await replacement
    await expect(rename).rejects.toThrow('会话已切换')
  })
})
