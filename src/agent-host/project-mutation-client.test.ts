import { expect, it } from 'vitest'
import { ProjectMutationClient } from './project-mutation-client'
import { WorkerMutationCapabilities } from '../main/worker-mutation-capabilities'
import { ProjectMutationLeases } from '../main/project-mutation-leases'
import type { MutationCapability } from '../shared/runtime-capabilities'

const identity = { sessionId: 'session', generation: 1 }
const tick = async () => {
  await new Promise((resolve) => setImmediate(resolve))
}
it('refuses a grant arriving after Stop and immediately returns the unused lease', async () => {
  const sent: MutationCapability[] = []
  const client = new ProjectMutationClient((message) => sent.push(message))
  const queued = client.acquire('write', identity)
  const rejected = expect(queued).rejects.toThrow('项目操作已取消')
  client.cancelQueued()
  client.accept({ type: 'project-mutation-response', requestId: sent[0].requestId, ok: true })
  await rejected
  expect(sent.at(-1)?.action).toBe('release')
})
it('Stop unblocks a queued tool without releasing another running tool', async () => {
  const server = new WorkerMutationCapabilities(new ProjectMutationLeases(async (cwd) => cwd))
  const a = new ProjectMutationClient((message) =>
    server.handle('A', '/project', identity, message, (reply) => a.accept(reply))
  )
  const b = new ProjectMutationClient((message) =>
    server.handle('B', '/project', identity, message, (reply) => b.accept(reply))
  )
  await a.acquire('write-A', identity)
  const queued = b.acquire('write-B', identity)
  const rejected = expect(queued).rejects.toThrow('项目操作已取消')
  b.cancelQueued()
  await rejected
  a.cancelQueued()
  let acquired = false
  const next = b.acquire('next-B', identity).then(() => {
    acquired = true
  })
  await tick()
  expect(acquired).toBe(false)
  a.release('write-A')
  await next
  b.release('next-B')
  await tick()
  expect(server.pending).toBe(false)
})
