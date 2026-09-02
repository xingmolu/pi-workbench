import type { WorkbenchSnapshot } from '../../../shared/contracts'

export type WorkbenchStatus = {
  snapshot: WorkbenchSnapshot
  error: string | null
}

export type WorkbenchStatusAction =
  | { type: 'snapshot'; snapshot: WorkbenchSnapshot }
  | { type: 'error'; message: string }
  | { type: 'clear' }

export const INITIAL_WORKBENCH_STATUS: WorkbenchStatus = {
  snapshot: {
    revision: 0,
    plugins: [],
    contributions: [],
    diagnostics: []
  },
  error: null
}

export function workbenchStatusReducer(
  state: WorkbenchStatus,
  action: WorkbenchStatusAction
): WorkbenchStatus {
  if (action.type === 'snapshot') return { snapshot: action.snapshot, error: null }
  if (action.type === 'clear') return state.error === null ? state : { ...state, error: null }
  return { ...state, error: `工作台：${action.message}` }
}
