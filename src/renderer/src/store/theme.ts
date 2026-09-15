import { useSyncExternalStore } from 'react'
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
export function useResolvedTheme(): ResolvedTheme {
  const preference = useDesktopSettings((state) => state.settings.theme)
  const dark = useSyncExternalStore(subscribe, systemIsDark, () => true)
  return resolveTheme(preference, dark)
}
export function applyDocumentTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
