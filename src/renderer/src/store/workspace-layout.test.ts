import { describe, expect, it } from 'vitest'
import { INITIAL_WORKSPACE_LAYOUT, workspaceLayoutReducer } from './workspace-layout'

describe('workspaceLayoutReducer', () => {
  it('preserves an expanded sidebar while settings are open', () => {
    const open = workspaceLayoutReducer(INITIAL_WORKSPACE_LAYOUT, { type: 'settings:open' })
    expect(open).toMatchObject({
      sidebarCollapsed: false,
      settingsOpen: true,
      sidebarCollapsedBeforeSettings: null
    })

    expect(workspaceLayoutReducer(open, { type: 'settings:close' })).toEqual(
      INITIAL_WORKSPACE_LAYOUT
    )
  })

  it('restores a sidebar that was already collapsed before settings opened', () => {
    const collapsed = workspaceLayoutReducer(INITIAL_WORKSPACE_LAYOUT, {
      type: 'sidebar:toggle'
    })
    const open = workspaceLayoutReducer(collapsed, { type: 'settings:open' })

    expect(workspaceLayoutReducer(open, { type: 'settings:close' })).toEqual(collapsed)
  })

  it('keeps the temporary rail locked while settings are open', () => {
    const open = workspaceLayoutReducer(INITIAL_WORKSPACE_LAYOUT, { type: 'settings:open' })
    expect(workspaceLayoutReducer(open, { type: 'sidebar:toggle' })).toBe(open)
  })
})
