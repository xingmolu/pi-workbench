export type WorkspaceLayoutState = {
  sidebarCollapsed: boolean
  settingsOpen: boolean
  sidebarCollapsedBeforeSettings: boolean | null
}

export type WorkspaceLayoutAction =
  { type: 'sidebar:toggle' } | { type: 'settings:open' } | { type: 'settings:close' }

export const INITIAL_WORKSPACE_LAYOUT: WorkspaceLayoutState = {
  sidebarCollapsed: false,
  settingsOpen: false,
  sidebarCollapsedBeforeSettings: null
}

export function workspaceLayoutReducer(
  state: WorkspaceLayoutState,
  action: WorkspaceLayoutAction
): WorkspaceLayoutState {
  switch (action.type) {
    case 'sidebar:toggle':
      return state.settingsOpen ? state : { ...state, sidebarCollapsed: !state.sidebarCollapsed }
    case 'settings:open':
      return state.settingsOpen
        ? state
        : {
            sidebarCollapsed: true,
            settingsOpen: true,
            sidebarCollapsedBeforeSettings: state.sidebarCollapsed
          }
    case 'settings:close':
      return state.settingsOpen
        ? {
            sidebarCollapsed: state.sidebarCollapsedBeforeSettings ?? state.sidebarCollapsed,
            settingsOpen: false,
            sidebarCollapsedBeforeSettings: null
          }
        : state
  }
}
