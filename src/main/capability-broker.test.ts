import { expect, it } from 'vitest'
import { CapabilityBroker } from './capability-broker'
import { WorkerMutationCapabilities } from './worker-mutation-capabilities'

it('keeps the old mutation capability name as a compatibility alias', () => {
  expect(WorkerMutationCapabilities).toBe(CapabilityBroker)
})

it('captures foreground authority only for the selected worker and matching native identity', () => {
  const broker = new CapabilityBroker()
  const selected = { workerId: 'worker-a', selectionEpoch: 7 }
  const identity = { sessionId: 'session-a', generation: 3 }

  expect(
    broker.captureForeground('worker-a', identity, selected, identity)
  ).toEqual({
    workerId: 'worker-a',
    selectionEpoch: 7,
    sessionId: 'session-a',
    generation: 3
  })
  expect(
    broker.captureForeground('worker-b', identity, selected, identity)
  ).toBeNull()
  expect(
    broker.captureForeground(
      'worker-a',
      identity,
      selected,
      { sessionId: 'session-a', generation: 4 }
    )
  ).toBeNull()
})

it('invalidates captured authority after desktop selection or native identity changes', () => {
  const broker = new CapabilityBroker()
  const identity = { sessionId: 'session-a', generation: 3 }
  const token = broker.captureForeground(
    'worker-a',
    identity,
    { workerId: 'worker-a', selectionEpoch: 7 },
    identity
  )!

  expect(
    broker.retainsForeground(
      token,
      { workerId: 'worker-a', selectionEpoch: 7 },
      identity
    )
  ).toBe(true)
  expect(
    broker.retainsForeground(
      token,
      { workerId: 'worker-a', selectionEpoch: 8 },
      identity
    )
  ).toBe(false)
  expect(
    broker.retainsForeground(
      token,
      { workerId: 'worker-a', selectionEpoch: 7 },
      { sessionId: 'session-b', generation: 1 }
    )
  ).toBe(false)
})
