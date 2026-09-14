import { expect, it } from 'vitest'
import { SessionOriginTracker } from './session-origin'

it('captures the current owner without allowing an old response to rewind it', () => {
  const tracker = new SessionOriginTracker()
  const a = {
    desktopScope: { workerId: 'a', selectionEpoch: 1 },
    sessionId: 'session-a',
    generation: 9
  }
  const b = {
    desktopScope: { workerId: 'b', selectionEpoch: 2 },
    sessionId: 'session-b',
    generation: 2
  }
  tracker.accept(a)
  const captured = tracker.capture()
  tracker.accept(b)
  tracker.accept(a)
  expect(captured?.scope.workerId).toBe('a')
  expect(tracker.capture()?.scope.workerId).toBe('b')
  tracker.accept({ ...a, desktopScope: undefined })
  expect(tracker.capture()?.scope.workerId).toBe('b')
})

it('retains native identity updates within a selection and ignores earlier generations', () => {
  const tracker = new SessionOriginTracker()
  const initial = {
    desktopScope: { workerId: 'a', selectionEpoch: 1 },
    sessionId: 'a',
    generation: 2
  }
  tracker.accept(initial)
  tracker.accept({ ...initial, sessionId: 'fork', generation: 3 })
  tracker.accept(initial)
  expect(tracker.capture()?.sessionId).toBe('fork')
})
