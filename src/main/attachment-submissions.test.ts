import { expect, it } from 'vitest'
import { AttachmentSubmissions, type AttachmentSubmission } from './attachment-submissions'

const scope = (generation: number) => ({
  projectPath: '/fixture',
  sessionId: `s${generation}`,
  generation
})
const entry = (generation: number): AttachmentSubmission => ({
  owner: 1,
  scope: scope(generation),
  files: [{ id: 'file', kind: 'text', name: 'fixture.txt', size: 7, text: 'payload' }],
  ids: ['file'],
  receipt: { submissionId: `submission-${generation}`, status: 'uncertain', code: 'unknown' },
  at: Date.now()
})

it('retains bounded uncertain ownership across live-session navigation until worker exit', () => {
  const cache = new AttachmentSubmissions({ retainUncertain: true })
  for (let generation = 0; generation < 32; generation++) {
    const captured = entry(generation)
    cache.set(captured.receipt.submissionId, captured)
  }
  cache.setContext(scope(33))
  expect(cache.size).toBe(32)
  expect(cache.get('submission-0')?.files).toEqual([])
  expect(cache.reserve('next')?.status).toBe('rejected')
  cache.retireScope(scope(0))
  expect(cache.reserve('next')).toBeNull()
  expect(cache.size).toBe(31)
})

it('releases obsolete unknowns through more than 32 scope transitions', () => {
  const cache = new AttachmentSubmissions()
  for (let generation = 0; generation < 40; generation++) {
    cache.setContext(scope(generation))
    expect(cache.reserve(`submission-${generation}`)).toBeNull()
    const captured = entry(generation)
    cache.set(captured.receipt.submissionId, captured)
    cache.setContext(scope(generation + 1))
    expect(captured.files).toEqual([])
    expect(cache.size).toBe(0)
  }
})

it('retains inflight identity until completion and rejects unrecorded capacity requests definitively', () => {
  const cache = new AttachmentSubmissions()
  for (let generation = 0; generation < 32; generation++) {
    const captured = entry(generation)
    captured.pending = new Promise(() => {})
    cache.set(captured.receipt.submissionId, captured)
  }
  cache.setContext(scope(33))
  expect(cache.size).toBe(32)
  expect(cache.get('submission-0')?.files[0].text).toBe('payload')
  expect(cache.reserve('unrecorded')).toEqual({
    submissionId: 'unrecorded',
    status: 'rejected',
    code: 'busy'
  })
  expect(cache.has('unrecorded')).toBe(false)
  const captured = cache.get('submission-0')!
  captured.pending = undefined
  cache.prune()
  expect(captured.files).toEqual([])
  expect(cache.reserve('fresh')).toBeNull()
})
