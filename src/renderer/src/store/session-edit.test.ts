import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_SNAPSHOT, usePiStore } from './pi-store'
import {
  closeSessionEdit,
  prepareSessionEdit,
  sendSessionEdit,
  useSessionEdit
} from './session-edit'
const token = '60627dcd-1217-41a3-b9ef-0df68ebfe2dc'
const snapshot = {
  ...EMPTY_SNAPSHOT,
  ready: true,
  sessionId: 'source',
  generation: 1,
  edit: { entryId: 'user', leafId: 'leaf', reason: null, pending: false }
}
beforeEach(() => {
  useSessionEdit.setState({
    scope: null,
    phase: 'closed',
    prepared: null,
    text: '',
    submissionId: null,
    receipt: null,
    message: null
  })
  usePiStore.setState({ snapshot, disconnected: false })
})
afterEach(() => vi.unstubAllGlobals())
const prepared = {
  type: 'prepared',
  token,
  text: 'original',
  attachments: [],
  scope: { sessionId: 'source', generation: 1, entryId: 'user', leafId: 'leaf' }
}

it.each(['error', 'throw'] as const)(
  'UI-only delayed unknown cancel %s cannot overwrite a new edit or a recovered panel',
  async (outcome) => {
    for (const transition of ['new-edit', 'recovery'] as const) {
      useSessionEdit.setState({
        scope: null,
        phase: 'closed',
        submissionId: null,
        recoveryRequired: false
      })
      usePiStore.setState({ snapshot, disconnected: false })
      let resolve!: (value: unknown) => void, reject!: (error: Error) => void
      const send = vi
        .fn()
        .mockResolvedValueOnce({ kind: 'session-edit', result: prepared })
        .mockRejectedValueOnce(new Error('lost'))
        .mockImplementationOnce(
          () =>
            new Promise((done, fail) => {
              resolve = done
              reject = fail
            })
        )
      vi.stubGlobal('window', { pi: { send } })
      await prepareSessionEdit(snapshot)
      await sendSessionEdit()
      const close = closeSessionEdit()
      if (transition === 'new-edit') {
        const other = { ...snapshot, sessionId: 'other' }
        usePiStore.setState({ snapshot: other })
        send.mockResolvedValueOnce({
          kind: 'session-edit',
          result: {
            ...prepared,
            token: '60627dcd-1217-41a3-b9ef-0df68ebfe2dd',
            scope: { ...prepared.scope, sessionId: 'other' }
          }
        })
        await prepareSessionEdit(other)
        useSessionEdit.setState({ message: 'new edit message' })
      } else {
        usePiStore.getState().disconnect('lost engine')
        usePiStore.getState().recover({ ...snapshot, generation: 2 })
      }
      const expected = useSessionEdit.getState()
      if (outcome === 'error')
        resolve({ kind: 'session-edit', result: { type: 'error', message: 'old cancel error' } })
      else reject(new Error('old cancel exception'))
      await close
      expect(useSessionEdit.getState()).toEqual(expected)
    }
  }
)

it('UI-only transport: late prepare cannot populate another session', async () => {
  let resolve!: (value: unknown) => void
  vi.stubGlobal('window', {
    pi: {
      send: () =>
        new Promise((done) => {
          resolve = done
        })
    }
  })
  const pending = prepareSessionEdit(snapshot)
  usePiStore.setState({ snapshot: { ...snapshot, sessionId: 'other' } })
  resolve({ kind: 'session-edit', result: prepared })
  await pending
  expect(useSessionEdit.getState().phase).toBe('closed')
  expect(useSessionEdit.getState().text).toBe('')
})

it('UI-only transport: same-session generation rotation retains unknown draft and query never resends', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ kind: 'session-edit', result: prepared })
    .mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce({ kind: 'session-edit', result: { type: 'error', message: 'unknown' } })
  vi.stubGlobal('window', { pi: { send } })
  await prepareSessionEdit(snapshot)
  useSessionEdit.setState({ text: 'edited' })
  await sendSessionEdit()
  usePiStore.setState({
    snapshot: { ...snapshot, generation: 2, edit: { ...snapshot.edit, leafId: 'parent' } }
  })
  expect(useSessionEdit.getState()).toMatchObject({ phase: 'uncertain', text: 'edited' })
  await sendSessionEdit(true)
  expect(send.mock.calls.map((call) => call[0].type)).toEqual([
    'session:edit:prepare',
    'session:edit:send',
    'session:edit:query'
  ])
})

it('UI-only transport: unknown close waits until Host confirms execution ended', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ kind: 'session-edit', result: prepared })
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValueOnce({
      kind: 'session-edit',
      result: { type: 'error', message: 'still running' }
    })
    .mockResolvedValueOnce({ kind: 'session-edit', result: { type: 'cancelled' } })
  vi.stubGlobal('window', { pi: { send } })
  await prepareSessionEdit(snapshot)
  await sendSessionEdit()
  await closeSessionEdit()
  expect(useSessionEdit.getState().phase).toBe('uncertain')
  await closeSessionEdit()
  expect(useSessionEdit.getState().phase).toBe('closed')
})
