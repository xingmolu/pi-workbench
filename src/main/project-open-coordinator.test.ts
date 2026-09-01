import { describe, expect, it } from 'vitest'
import { ProjectOpenCoordinator } from './project-open-coordinator'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ProjectOpenCoordinator', () => {
  it('runs startup restore at most once', async () => {
    const coordinator = new ProjectOpenCoordinator<string>()
    let calls = 0
    const restore = (): Promise<string> => {
      calls += 1
      return Promise.resolve('restored')
    }

    await expect(
      Promise.all([coordinator.restoreOnce(restore), coordinator.restoreOnce(restore)])
    ).resolves.toEqual(['restored', 'restored'])
    expect(calls).toBe(1)
  })

  it('attempts restore once but reads current state for every request', async () => {
    const coordinator = new ProjectOpenCoordinator<string>()
    let restoreCalls = 0
    let stateReads = 0
    const restore = async (): Promise<string> => {
      restoreCalls += 1
      return 'restore-snapshot'
    }
    const readCurrent = async (): Promise<string> => {
      stateReads += 1
      return `current-${stateReads}`
    }

    await expect(coordinator.restoreThenRead(restore, readCurrent)).resolves.toBe('current-1')
    await expect(coordinator.restoreThenRead(restore, readCurrent)).resolves.toBe('current-2')
    expect(restoreCalls).toBe(1)
    expect(stateReads).toBe(2)
  })

  it('serializes a user open behind an in-flight restore so the user choice wins last', async () => {
    const coordinator = new ProjectOpenCoordinator<string>()
    const restoreGate = deferred<string>()
    const order: string[] = []
    const restore = coordinator.restoreOnce(async () => {
      order.push('restore:start')
      const result = await restoreGate.promise
      order.push('restore:end')
      return result
    })

    await Promise.resolve()
    const userOpen = coordinator.runUserOpen(async () => {
      order.push('user')
      return 'user-project'
    })
    restoreGate.resolve('restored-project')

    await expect(restore).resolves.toBe('restored-project')
    await expect(userOpen).resolves.toBe('user-project')
    expect(order).toEqual(['restore:start', 'restore:end', 'user'])
  })

  it('skips a not-yet-started restore after the user has requested a project', async () => {
    const coordinator = new ProjectOpenCoordinator<string>()
    const blocker = deferred<void>()
    const first = coordinator.runUserOpen(async () => {
      await blocker.promise
      return 'user-project'
    })
    let restoreCalls = 0
    const restore = coordinator.restoreOnce(async () => {
      restoreCalls += 1
      return 'restored-project'
    })
    blocker.resolve()

    await expect(first).resolves.toBe('user-project')
    await expect(restore).resolves.toBeNull()
    expect(restoreCalls).toBe(0)
  })

  it('serializes state reads with project replacement', async () => {
    const coordinator = new ProjectOpenCoordinator<string>()
    const gate = deferred<void>()
    const order: string[] = []
    const open = coordinator.runUserOpen(async () => {
      order.push('open:start')
      await gate.promise
      order.push('open:end')
      return 'project'
    })
    const read = coordinator.runStateRead(async () => {
      order.push('read')
      return 'state'
    })
    gate.resolve()

    await expect(open).resolves.toBe('project')
    await expect(read).resolves.toBe('state')
    expect(order).toEqual(['open:start', 'open:end', 'read'])
  })
})
