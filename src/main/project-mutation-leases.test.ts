import { expect, it } from 'vitest'
import { ProjectMutationLeases } from './project-mutation-leases'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('serializes mutations for the same canonical cwd while other projects progress', async () => {
  const leases = new ProjectMutationLeases(async (cwd) => cwd.replace('/alias', '/project'))
  const hold = deferred()
  const order: string[] = []
  const a = leases.run('a', '/project', async () => {
    order.push('a')
    await hold.promise
  })
  const b = leases.run('b', '/alias', async () => {
    order.push('b')
  })
  await leases.run('c', '/other', async () => {
    order.push('c')
  })
  expect(order).toEqual(['a', 'c'])
  hold.resolve()
  await Promise.all([a, b])
  expect(order).toEqual(['a', 'c', 'b'])
})

it('aborts queued work and never releases active writes prematurely on worker exit', async () => {
  const leases = new ProjectMutationLeases(async (cwd) => cwd)
  const hold = deferred()
  const started = deferred()
  let activeSignal!: AbortSignal
  const a = leases.run('a', '/project', async (signal) => {
    activeSignal = signal
    started.resolve()
    await hold.promise
  })
  await started.promise
  const abort = new AbortController()
  const cancelled = leases.run(
    'b',
    '/project',
    async () => {
      throw new Error('must not execute')
    },
    abort.signal
  )
  const rejected = expect(cancelled).rejects.toThrow('cancelled')
  abort.abort()
  await rejected
  leases.cancelOwner('a')
  expect(activeSignal.aborted).toBe(true)
  let replacementStarted = false
  const replacement = leases.run('c', '/project', async () => {
    replacementStarted = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(replacementStarted).toBe(false)
  hold.resolve()
  await Promise.all([a, replacement])
  expect(replacementStarted).toBe(true)
})
