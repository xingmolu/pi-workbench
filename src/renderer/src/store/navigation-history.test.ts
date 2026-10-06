import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, canStep, step, visit, type HistoryLocation } from './navigation-history'

const session = (path: string): HistoryLocation => ({ kind: 'session', cwd: '/p', path })
const page = (viewId: string): HistoryLocation => ({ kind: 'page', viewId })

describe('navigation history', () => {
  it('records places once and steps back and forward through them', () => {
    let history = visit(visit(visit(EMPTY_HISTORY, session('a')), session('a')), page('review'))
    history = visit(history, session('b'))
    expect(history.entries).toHaveLength(3)
    const back = step(history, -1)!
    expect(back.target).toEqual(page('review'))
    // Arriving at the step's target does not record it again.
    expect(visit(back.history, page('review'))).toBe(back.history)
    expect(step(back.history, 1)!.target).toEqual(session('b'))
    expect(canStep(EMPTY_HISTORY, -1)).toBe(false)
  })

  it('drops the forward places when going somewhere new', () => {
    const history = visit(visit(EMPTY_HISTORY, session('a')), session('b'))
    const back = step(history, -1)!.history
    const next = visit(back, session('c'))
    expect(next.entries).toEqual([session('a'), session('c')])
    expect(canStep(next, 1)).toBe(false)
  })

  it('skips places that are gone', () => {
    const history = visit(visit(visit(EMPTY_HISTORY, session('a')), page('gone')), session('b'))
    const back = step(history, -1, (location) => location.kind !== 'page')!
    expect(back.target).toEqual(session('a'))
    expect(back.history.index).toBe(0)
  })
})
