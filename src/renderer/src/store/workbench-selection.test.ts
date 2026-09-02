import { describe, expect, it } from 'vitest'
import type { WorkbenchContribution } from '../../../shared/contracts'
import { INITIAL_WORKBENCH_SELECTION, workbenchSelectionReducer } from './workbench-selection'

function contribution(viewId: string): WorkbenchContribution {
  return {
    pluginId: 'works.pi.desktop.test',
    viewId,
    title: viewId,
    icon: 'plugin',
    activation: 'onApp',
    surface: { kind: 'sandboxed-web' }
  }
}

describe('workbenchSelectionReducer', () => {
  it('initially selects the first contribution in snapshot order', () => {
    const state = workbenchSelectionReducer(INITIAL_WORKBENCH_SELECTION, {
      type: 'snapshot',
      contributions: [contribution('files'), contribution('review')]
    })

    expect(state).toEqual({
      selectedViewId: 'files',
      availableViewIds: ['files', 'review']
    })
  })

  it('preserves the current selection across reordered snapshot refreshes', () => {
    const selected = workbenchSelectionReducer(
      {
        selectedViewId: 'review',
        availableViewIds: ['files', 'review']
      },
      {
        type: 'snapshot',
        contributions: [contribution('review'), contribution('files')]
      }
    )

    expect(selected).toEqual({
      selectedViewId: 'review',
      availableViewIds: ['review', 'files']
    })
  })

  it('falls back to the first contribution when the selected view is disabled or removed', () => {
    const state = workbenchSelectionReducer(
      {
        selectedViewId: 'review',
        availableViewIds: ['files', 'review']
      },
      { type: 'snapshot', contributions: [contribution('browser'), contribution('files')] }
    )

    expect(state.selectedViewId).toBe('browser')
  })

  it('falls back to null when no contributions remain', () => {
    const state = workbenchSelectionReducer(
      {
        selectedViewId: 'review',
        availableViewIds: ['review']
      },
      { type: 'snapshot', contributions: [] }
    )

    expect(state).toEqual({ selectedViewId: null, availableViewIds: [] })
  })

  it('ignores a reveal for an absent contribution', () => {
    const state = {
      selectedViewId: 'files',
      availableViewIds: ['files', 'review']
    } as const

    expect(workbenchSelectionReducer(state, { type: 'reveal', viewId: 'missing' })).toBe(state)
  })

  it('ignores an explicit user selection for an absent contribution', () => {
    const state = {
      selectedViewId: 'files',
      availableViewIds: ['files', 'review']
    } as const

    expect(workbenchSelectionReducer(state, { type: 'select', viewId: 'missing' })).toBe(state)
  })

  it('keeps contribution ordering deterministic without mutating the snapshot', () => {
    const contributions = [
      contribution('review'),
      contribution('files'),
      contribution('review'),
      contribution('browser')
    ]
    const original = contributions.map(({ viewId }) => viewId)

    const first = workbenchSelectionReducer(INITIAL_WORKBENCH_SELECTION, {
      type: 'snapshot',
      contributions
    })
    const second = workbenchSelectionReducer(INITIAL_WORKBENCH_SELECTION, {
      type: 'snapshot',
      contributions
    })

    expect(first.availableViewIds).toEqual(['review', 'files', 'browser'])
    expect(second).toEqual(first)
    expect(contributions.map(({ viewId }) => viewId)).toEqual(original)
  })
})
