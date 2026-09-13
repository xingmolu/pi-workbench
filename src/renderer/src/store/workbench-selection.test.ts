import { describe, expect, it } from 'vitest'
import {
  INITIAL_WORKBENCH_SELECTION,
  workbenchSelectionReducer as reduce
} from './workbench-selection'
const snapshot = (ids: string[]) => ({
  type: 'snapshot' as const,
  contributions: ids.map((viewId) => ({ viewId }))
})
const available = () =>
  reduce(INITIAL_WORKBENCH_SELECTION, snapshot(['files', 'browser', 'terminal']))
const opened = () =>
  ['files', 'browser', 'terminal'].reduce(
    (state, viewId) => reduce(state, { type: 'select', viewId }),
    available()
  )
describe('workbench tabs', () => {
  it('starts with a launcher and deduplicates registry IDs', () => {
    expect(reduce(INITIAL_WORKBENCH_SELECTION, snapshot(['files', 'files']))).toEqual({
      availableViewIds: ['files'],
      openedViewIds: [],
      selectedViewId: null
    })
  })
  it('validates selection and reveal', () => {
    const state = available()
    for (const type of ['select', 'reveal', 'close'] as const)
      expect(reduce(state, { type, viewId: 'absent' })).toBe(state)
  })
  it('opens and selects revealed contributions only once', () => {
    const state = reduce(available(), { type: 'reveal', viewId: 'browser' })
    expect(state.openedViewIds).toEqual(['browser'])
    expect(state.selectedViewId).toBe('browser')
    expect(reduce(state, { type: 'select', viewId: 'browser' })).toBe(state)
  })
  it('selects the right neighbor then left when closing the active tab', () => {
    const state = reduce(opened(), { type: 'select', viewId: 'browser' })
    const next = reduce(state, { type: 'close', viewId: 'browser' })
    expect(next.selectedViewId).toBe('terminal')
    expect(reduce(next, { type: 'close', viewId: 'terminal' }).selectedViewId).toBe('files')
  })
  it('closing inactive tabs preserves selection; closing last returns launcher', () => {
    const state = reduce(opened(), { type: 'close', viewId: 'browser' })
    expect(state.selectedViewId).toBe('terminal')
    const last = reduce(reduce(state, { type: 'close', viewId: 'files' }), {
      type: 'close',
      viewId: 'terminal'
    })
    expect(last.openedViewIds).toEqual([])
    expect(last.selectedViewId).toBeNull()
  })
  it('refresh keeps tab order and falls back only among surviving opened tabs', () => {
    const state = reduce(opened(), snapshot(['new', 'browser', 'files', 'browser']))
    expect(state.openedViewIds).toEqual(['files', 'browser'])
    expect(state.selectedViewId).toBe('browser')
    expect(reduce(state, snapshot(['new'])).selectedViewId).toBeNull()
  })
})
