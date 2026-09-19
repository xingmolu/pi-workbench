import { beforeEach, expect, it } from 'vitest'
import { EMPTY_SNAPSHOT, usePiStore } from './pi-store'
import { diffState } from '../../../shared/state-patch'

const snapshot = (workerId: string, selectionEpoch: number, generation: number, revision = 1) => ({
  ...EMPTY_SNAPSHOT,
  ready: true,
  sessionId: workerId,
  generation,
  revision,
  desktopScope: { workerId, selectionEpoch }
})

beforeEach(() => usePiStore.getState().recover(EMPTY_SNAPSHOT))

it('recovers a disconnected foreground only from a newer ready selection', () => {
  usePiStore.getState().setSnapshot(snapshot('a', 1, 9))
  usePiStore.getState().disconnect('worker exited')
  usePiStore.getState().setSnapshot(snapshot('a', 1, 10))
  expect(usePiStore.getState().disconnected).toBe(true)
  usePiStore.getState().setSnapshot(snapshot('b', 2, 1))
  expect(usePiStore.getState().disconnected).toBe(false)
  expect(usePiStore.getState().snapshot.sessionId).toBe('b')
})

it('switches back to a resident with a lower native generation using the desktop epoch', () => {
  usePiStore.getState().setSnapshot(snapshot('a', 1, 9))
  usePiStore.getState().setSnapshot(snapshot('b', 2, 2))
  expect(usePiStore.getState().snapshot.sessionId).toBe('b')
  usePiStore.getState().setSnapshot(snapshot('a', 3, 9))
  expect(usePiStore.getState().snapshot.sessionId).toBe('a')
})

it('ignores an old view response even when it has a greater native generation/revision', () => {
  usePiStore.getState().setSnapshot(snapshot('b', 2, 2))
  usePiStore.getState().setSnapshot(snapshot('a', 1, 99, 100))
  expect(usePiStore.getState().snapshot.sessionId).toBe('b')
})

it('ignores late patches from an old view without forcing a foreground resync', () => {
  const a = snapshot('a', 1, 9)
  usePiStore.getState().setSnapshot(snapshot('b', 2, 2))
  const patch = diffState(a, { ...a, revision: 2, busy: true })
  patch.meta.desktopScope = a.desktopScope
  expect(usePiStore.getState().applyPatch(patch)).toBe('ignored')
  expect(usePiStore.getState().snapshot.busy).toBe(false)
})

it('still requests resync for an actual foreground patch revision gap', () => {
  const b = snapshot('b', 2, 2)
  usePiStore.getState().setSnapshot(b)
  const patch = diffState({ ...b, revision: 5 }, { ...b, revision: 6 })
  patch.meta.desktopScope = b.desktopScope
  expect(usePiStore.getState().applyPatch(patch)).toBe('needsSnapshot')
})

it('does not let an unscoped old snapshot replace a scoped foreground', () => {
  usePiStore.getState().setSnapshot(snapshot('b', 2, 2))
  usePiStore.getState().setSnapshot({ ...EMPTY_SNAPSHOT, generation: 100 })
  expect(usePiStore.getState().snapshot.sessionId).toBe('b')
})

it('an explicit close epoch returns to the lobby and rejects stale snapshots and patches', () => {
  const a = snapshot('a', 4, 8)
  usePiStore.getState().setSnapshot(a)
  usePiStore.getState().setSnapshot({ ...EMPTY_SNAPSHOT, ready: true, desktopEpoch: 5 })
  expect(usePiStore.getState().snapshot.desktopScope).toBeUndefined()
  expect(usePiStore.getState().snapshot.sessionId).toBeNull()
  usePiStore.getState().setSnapshot({ ...a, revision: 999 })
  const late = diffState(a, { ...a, revision: 2, busy: true })
  late.meta.desktopScope = a.desktopScope
  expect(usePiStore.getState().applyPatch(late)).toBe('ignored')
  expect(usePiStore.getState().snapshot.project).toBeNull()
  usePiStore.getState().setSnapshot(snapshot('b', 6, 1))
  expect(usePiStore.getState().snapshot.sessionId).toBe('b')
})
