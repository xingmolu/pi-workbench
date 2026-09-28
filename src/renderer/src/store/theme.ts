import { createContext, useContext, useSyncExternalStore } from 'react'
import { useDesktopSettings } from './desktop-settings'
import type { DesktopSettings } from '../../../shared/desktop-settings'

export type ResolvedTheme = 'dark' | 'light'
export function resolveTheme(
  preference: DesktopSettings['theme'],
  systemDark: boolean
): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}
let media: MediaQueryList | undefined
function systemMedia(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || !window.matchMedia) return undefined
  return (media ??= window.matchMedia('(prefers-color-scheme: dark)'))
}
function subscribe(onChange: () => void): () => void {
  const query = systemMedia()
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}
export function systemIsDark(): boolean {
  return systemMedia()?.matches ?? true
}
/** Lets a surface with its own theme choice (the mobile page) drive shared components. */
export const ResolvedThemeOverride = createContext<ResolvedTheme | null>(null)
export function useResolvedTheme(): ResolvedTheme {
  const override = useContext(ResolvedThemeOverride)
  const preference = useDesktopSettings((state) => state.settings.theme)
  const dark = useSyncExternalStore(subscribe, systemIsDark, () => true)
  return override ?? resolveTheme(preference, dark)
}
export function applyDocumentTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
