import { expect, it } from 'vitest'
import { forkCurrentSession, refreshForkFailure } from './session-fork'

it('reads the selected canonical boundary again after preparation', async () => {
  const target = { sessionId: 'source', generation: 1, entryId: 'middle' }
  const reads: unknown[] = []
  await expect(forkCurrentSession(target, {
    readTarget: (entryId?: string) => { reads.push(entryId); return entryId === 'middle' ? { ...target, eligible: true, reason: null } : null },
    prepare: async () => {}, fork: async () => ({ cancelled: false }), refreshAfterFailure: async () => {}
  })).resolves.toEqual({ cancelled: false })
  expect(reads).toEqual(['middle', 'middle'])
})

it('reports preparation failure before starting without leaking the raw exception and refreshes actual state', async () => {
  const target = { sessionId: 'source', generation: 1, entryId: 'leaf' }
  const cause = new Error('raw auth projection failure with sensitive implementation details')
  let forks = 0
  const refreshed: string[] = []
  await expect(
    forkCurrentSession(target, {
      readTarget: () => ({ ...target, eligible: true, reason: null }),
      prepare: async () => {
        throw cause
      },
      fork: async () => {
        forks++
        return { cancelled: false }
      },
      refreshAfterFailure: () =>
        refreshForkFailure({
          refreshAuth: async () => {
            refreshed.push('auth')
            throw new Error('auth still unavailable')
          },
          refreshSessions: async () => {
            refreshed.push('sessions')
          },
          publishSnapshot: () => {
            refreshed.push('snapshot')
          }
        })
    })
  ).rejects.toMatchObject({
    message: '分叉尚未开始：准备会话失败。请核对当前会话和列表后重新打开分叉确认。',
    cause
  })
  expect(forks).toBe(0)
  expect(refreshed).toEqual(['auth', 'sessions', 'snapshot'])
})

it('rejects a target that changes during preparation before calling the public fork operation', async () => {
  let writes = 0
  const target = { sessionId: 'source', generation: 1, entryId: 'leaf' }
  let current = { ...target, eligible: true, reason: null }
  await expect(
    forkCurrentSession(target, {
      readTarget: () => current,
      prepare: async () => {
        current = { ...current, generation: 2 }
      },
      fork: async () => {
        writes++
        return { cancelled: false }
      },
      refreshAfterFailure: async () => {}
    })
  ).rejects.toThrow('会话已变化')
  expect(writes).toBe(0)
})

it('attempts child discovery and publishes actual state even when auth refresh fails', async () => {
  const events: string[] = []
  await refreshForkFailure({
    refreshAuth: async () => {
      throw new Error('auth unavailable')
    },
    refreshSessions: async () => {
      events.push('list')
    },
    publishSnapshot: () => {
      events.push('actual snapshot')
    }
  })
  expect(events).toEqual(['list', 'actual snapshot'])
})

it('preserves the SDK failure cause even when child discovery fails', async () => {
  const target = { sessionId: 'source', generation: 1, entryId: 'leaf' }
  const cause = new Error('SDK child applied then rebind failed')
  await expect(
    forkCurrentSession(target, {
      readTarget: () => ({ ...target, eligible: true, reason: null }),
      prepare: async () => {},
      fork: async () => {
        throw cause
      },
      refreshAfterFailure: async () => {
        throw new Error('list unavailable')
      }
    })
  ).rejects.toMatchObject({
    cause,
    message: '分叉未完成；可能已创建新会话。请核对当前会话和列表，不要直接重试。'
  })
})
