import { expect, it } from 'vitest'
import { WorkerMutationCapabilities } from './worker-mutation-capabilities'
import { ProjectMutationLeases } from './project-mutation-leases'
import type { MutationResponse } from '../shared/runtime-capabilities'

const identity = { sessionId: 'session', generation: 1 }
const acquire = (requestId: string) => ({
  type: 'project-mutation',
  action: 'acquire',
  requestId,
  ...identity
})
const tick = async () => {
  await new Promise((resolve) => setImmediate(resolve))
}
it('queued Stop cancels admission, while a running Stop retains the project until completion', async () => {
  const leases = new WorkerMutationCapabilities(new ProjectMutationLeases(async (cwd) => cwd))
  const responses: MutationResponse[] = []
  const reply = (response: MutationResponse) => responses.push(response)
  leases.handle('A', '/project', identity, acquire('a'), reply)
  leases.handle('B', '/project', identity, acquire('b'), reply)
  await tick()
  expect(responses).toEqual([{ type: 'project-mutation-response', requestId: 'a', ok: true }])
  leases.handle(
    'A',
    '/project',
    identity,
    { type: 'project-mutation', action: 'cancel', requestId: 'a' },
    reply
  )
  await tick()
  expect(responses).toHaveLength(1)
  leases.handle(
    'B',
    '/project',
    identity,
    { type: 'project-mutation', action: 'cancel', requestId: 'b' },
    reply
  )
  await tick()
  expect(responses.at(-1)).toEqual({ type: 'project-mutation-response', requestId: 'b', ok: false })
  leases.handle('C', '/project', identity, acquire('c'), reply)
  await tick()
  expect(responses).toHaveLength(2)
  leases.handle(
    'A',
    '/project',
    identity,
    { type: 'project-mutation', action: 'release', requestId: 'a' },
    reply
  )
  await tick()
  expect(responses.at(-1)).toEqual({ type: 'project-mutation-response', requestId: 'c', ok: true })
  leases.exit('C')
  await tick()
  expect(leases.pending).toBe(false)
})

it('actual process exit releases granted ownership and unrelated projects run independently', async () => {
  const leases = new WorkerMutationCapabilities(new ProjectMutationLeases(async (cwd) => cwd))
  const responses: MutationResponse[] = []
  const reply = (response: MutationResponse) => responses.push(response)
  leases.handle('A', '/project', identity, acquire('a'), reply)
  leases.handle('B', '/project', identity, acquire('b'), reply)
  leases.handle('C', '/other', identity, acquire('c'), reply)
  await tick()
  expect(responses.map((r) => r.requestId)).toEqual(['a', 'c'])
  leases.exit('A')
  await tick()
  expect(responses.at(-1)?.requestId).toBe('b')
  leases.exit('B')
  leases.exit('C')
})
