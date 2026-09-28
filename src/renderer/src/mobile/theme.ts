import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ResolvedTheme } from '../store/theme'

export type MobileThemeChoice = 'system' | 'dark' | 'light'
const THEME_KEY = 'pi-mobile-theme'

function stored(): MobileThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'dark' || value === 'light' ? value : 'system'
  } catch {
    return 'system'
  }
}

const media = window.matchMedia('(prefers-color-scheme: light)')
const subscribe = (change: () => void): (() => void) => {
  media.addEventListener('change', change)
  return () => media.removeEventListener('change', change)
}

/** Applied before first render so the page never flashes the other theme. */
export function applyStoredTheme(): void {
  const choice = stored()
  if (choice === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = choice
}

export function useMobileTheme(): {
  choice: MobileThemeChoice
  resolved: ResolvedTheme
  setChoice: (choice: MobileThemeChoice) => void
} {
  const [choice, setChoice] = useState(stored)
  const systemLight = useSyncExternalStore(subscribe, () => media.matches)
  const resolved: ResolvedTheme = choice === 'system' ? (systemLight ? 'light' : 'dark') : choice
  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, choice)
    } catch {
      /* The choice still applies for this visit. */
    }
    applyStoredTheme()
    document
      .querySelector('meta[name=theme-color]')
      ?.setAttribute('content', resolved === 'dark' ? '#0b0b0c' : '#f3f3f5')
  }, [choice, resolved])
  return { choice, resolved, setChoice }
}
