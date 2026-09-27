import { create } from 'zustand'
import type { PluginThemeSummary } from '../../../shared/workbench-contracts'
import type { DesktopSettings } from '../../../shared/desktop-settings'

/** Themes offered by enabled plugins, from the latest Workbench snapshot. */
export const usePluginThemes = create<{
  themes: PluginThemeSummary[]
  setThemes: (themes: PluginThemeSummary[]) => void
}>((set) => ({
  themes: [],
  setThemes: (themes) => set({ themes })
}))

let appliedTokens: string[] = []

/**
 * Applies the accent and, when the selected plugin theme is available, its token overrides.
 * A theme whose plugin was disabled simply stops applying; the light/dark base stays.
 */
export function applyThemeOverrides(
  accent: DesktopSettings['accent'],
  theme: PluginThemeSummary | null,
  root: HTMLElement = document.documentElement
): void {
  root.dataset.accent = accent
  for (const token of appliedTokens) root.style.removeProperty(token)
  appliedTokens = []
  if (!theme) {
    delete root.dataset.pluginTheme
    return
  }
  root.dataset.pluginTheme = theme.id
  for (const [token, value] of Object.entries(theme.tokens)) {
    if (!token.startsWith('--')) continue
    root.style.setProperty(token, value)
    appliedTokens.push(token)
  }
}
