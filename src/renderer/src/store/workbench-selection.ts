import type { WorkbenchContribution } from '../../../shared/contracts'

export type WorkbenchSelectionState = {
  selectedViewId: string | null
  availableViewIds: readonly string[]
}

export type WorkbenchSelectionAction =
  | { type: 'snapshot'; contributions: readonly Pick<WorkbenchContribution, 'viewId'>[] }
  | { type: 'select'; viewId: string }
  | { type: 'reveal'; viewId: string }

export const INITIAL_WORKBENCH_SELECTION: WorkbenchSelectionState = {
  selectedViewId: null,
  availableViewIds: []
}

function orderedViewIds(contributions: readonly Pick<WorkbenchContribution, 'viewId'>[]): string[] {
  const seen = new Set<string>()
  const viewIds: string[] = []
  for (const { viewId } of contributions) {
    if (seen.has(viewId)) continue
    seen.add(viewId)
    viewIds.push(viewId)
  }
  return viewIds
}

export function workbenchSelectionReducer(
  state: WorkbenchSelectionState,
  action: WorkbenchSelectionAction
): WorkbenchSelectionState {
  if (action.type === 'snapshot') {
    const availableViewIds = orderedViewIds(action.contributions)
    return {
      selectedViewId:
        state.selectedViewId && availableViewIds.includes(state.selectedViewId)
          ? state.selectedViewId
          : (availableViewIds[0] ?? null),
      availableViewIds
    }
  }

  if (!state.availableViewIds.includes(action.viewId) || state.selectedViewId === action.viewId) {
    return state
  }
  return { ...state, selectedViewId: action.viewId }
}
