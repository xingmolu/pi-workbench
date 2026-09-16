import type { WorkbenchContribution } from '../../../shared/contracts'

export type WorkbenchSelectionState = {
  selectedViewId: string | null
  openedViewIds: readonly string[]
  availableViewIds: readonly string[]
}

export type WorkbenchSelectionAction =
  | { type: 'snapshot'; contributions: readonly Pick<WorkbenchContribution, 'viewId'>[] }
  | { type: 'select'; viewId: string }
  | { type: 'reveal'; viewId: string }
  | { type: 'close'; viewId: string }

export const INITIAL_WORKBENCH_SELECTION: WorkbenchSelectionState = {
  selectedViewId: null,
  openedViewIds: [],
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
    const openedViewIds = state.openedViewIds.filter((id) => availableViewIds.includes(id))
    return {
      selectedViewId:
        state.selectedViewId && availableViewIds.includes(state.selectedViewId)
          ? state.selectedViewId
          : (openedViewIds[
              Math.min(
                state.openedViewIds.indexOf(state.selectedViewId ?? ''),
                openedViewIds.length - 1
              )
            ] ?? null),
      openedViewIds,
      availableViewIds
    }
  }

  if (!state.availableViewIds.includes(action.viewId)) return state
  if (action.type === 'close') {
    const index = state.openedViewIds.indexOf(action.viewId)
    if (index < 0) return state
    const openedViewIds = state.openedViewIds.filter((id) => id !== action.viewId)
    return {
      ...state,
      openedViewIds,
      selectedViewId:
        state.selectedViewId === action.viewId
          ? (openedViewIds[Math.min(index, openedViewIds.length - 1)] ?? null)
          : state.selectedViewId
    }
  }
  if (state.selectedViewId === action.viewId) {
    return state
  }
  return {
    ...state,
    selectedViewId: action.viewId,
    openedViewIds: state.openedViewIds.includes(action.viewId)
      ? state.openedViewIds
      : [...state.openedViewIds, action.viewId]
  }
}
