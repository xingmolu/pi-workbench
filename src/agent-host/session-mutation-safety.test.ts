import { describe, expect, it } from 'vitest'
import { SerialExecutor } from './serial-executor'
import { SessionPersistenceGuard } from './session-rename'
import { guardModelMutation, SessionRuntimeUnsafeError } from './session-mutation-safety'

// Deliberately fake operations: SDK/filesystem evidence lives in session-model-sdk.test.ts.
function fixture() {
  const state = {
    model: { provider: 'test', id: 'same' },
    thinkingLevel: 'high',
    leaf: 'a',
    entries: [{ id: 'a' }]
  }
  const session = {
    get model() {
      return state.model
    },
    get thinkingLevel() {
      return state.thinkingLevel
    },
    sessionManager: { getLeafId: () => state.leaf, getEntries: () => state.entries }
  }
  return { state, session, guard: new SessionPersistenceGuard() }
}

describe('model mutation rejection safety', () => {
  it('keeps an unchanged auth/preflight rejection recoverable', async () => {
    const { session, guard } = fixture()
    const auth = new Error('no auth')
    await expect(
      guard.run(() =>
        guardModelMutation(session, async () => {
          throw auth
        })
      )
    ).rejects.toBe(auth)
    await expect(guard.run(async () => 'usable')).resolves.toBe('usable')
  })

  it.each(['model identity', 'thinking', 'leaf', 'entry IDs', 'same model append'])(
    'latches on rejected mutation of %s',
    async (change) => {
      const { session, state, guard } = fixture()
      await expect(
        guard.run(() =>
          guardModelMutation(session, async () => {
            if (change === 'model identity') state.model = { ...state.model }
            if (change === 'thinking') state.thinkingLevel = 'off'
            if (change === 'leaf') state.leaf = 'b'
            if (change === 'entry IDs') state.entries[0].id = 'b'
            if (change === 'same model append') state.entries.push({ id: 'b' })
            throw new Error('secret SDK detail')
          })
        )
      ).rejects.toThrow('模型更新未完成，运行时已停止；请重新连接')
      await expect(guard.run(async () => 'must not run')).rejects.toBeInstanceOf(
        SessionRuntimeUnsafeError
      )
    }
  )

  it.each(['before', 'after'])(
    'fails closed when snapshot reading fails %s mutation',
    async (when) => {
      const { session, guard } = fixture()
      let attempted = false
      session.sessionManager.getEntries = () => {
        if (when === 'before' || attempted) throw new Error('snapshot unavailable')
        return [{ id: 'a' }]
      }
      await expect(
        guard.run(() =>
          guardModelMutation(session, async () => {
            attempted = true
            throw new Error('rejected')
          })
        )
      ).rejects.toBeInstanceOf(SessionRuntimeUnsafeError)
      expect(attempted).toBe(when === 'after')
      await expect(guard.run(async () => 'blocked')).rejects.toBeInstanceOf(
        SessionRuntimeUnsafeError
      )
    }
  )

  it('rejects both queued and new host operations without running their bodies', async () => {
    const { session, state, guard } = fixture()
    const executor = new SerialExecutor()
    const invoked: string[] = []
    const first = executor.run(() =>
      guard.run(() =>
        guardModelMutation(session, async () => {
          state.leaf = 'poisoned'
          throw new Error('failed')
        })
      )
    )
    const queued = executor.run(() =>
      guard.run(async () => {
        invoked.push('queued')
      })
    )
    await expect(first).rejects.toBeInstanceOf(SessionRuntimeUnsafeError)
    await expect(queued).rejects.toBeInstanceOf(SessionRuntimeUnsafeError)
    await expect(
      guard.run(async () => {
        invoked.push('new')
      })
    ).rejects.toBeInstanceOf(SessionRuntimeUnsafeError)
    expect(invoked).toEqual([])
  })

  it('accepts successful mutation and leaves the gate open', async () => {
    const { session, state, guard } = fixture()
    await guard.run(() =>
      guardModelMutation(session, async () => {
        state.leaf = 'b'
      })
    )
    await expect(guard.run(async () => 'usable')).resolves.toBe('usable')
  })
})
