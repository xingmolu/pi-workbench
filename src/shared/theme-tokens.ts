/**
 * Design tokens a plugin theme may override. Themes change colors and shadows only: a
 * theme's CSS is reduced to `--token: value` pairs from this list and applied as inline
 * custom properties, so a theme can never add selectors, load resources or change layout.
 */
export const THEME_TOKENS = [
  '--canvas',
  '--raised',
  '--composer',
  '--chip',
  '--text',
  '--text-soft',
  '--muted',
  '--muted-2',
  '--line',
  '--line-soft',
  '--accent',
  '--accent-hover',
  '--accent-text',
  '--accent-soft',
  '--accent-border',
  '--success',
  '--success-text',
  '--danger',
  '--danger-bg',
  '--danger-border',
  '--danger-text',
  '--warning',
  '--warning-text',
  '--warning-bg',
  '--warning-border',
  '--sidebar-text',
  '--sidebar-secondary',
  '--sidebar-selected',
  '--sidebar-running',
  '--surface-sunken',
  '--surface-subtle',
  '--surface-floating',
  '--surface-selected',
  '--surface-hover',
  '--border-strong',
  '--border-focus',
  '--text-strong',
  '--text-secondary',
  '--text-tertiary',
  '--selection-wash',
  '--scrim',
  '--popup-shadow',
  '--diff-add',
  '--diff-del',
  '--diff-surface',
  '--shadow-sm',
  '--shadow-md'
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]
const ALLOWED: ReadonlySet<string> = new Set(THEME_TOKENS)

export const MAX_THEME_CSS_BYTES = 256 * 1024

/** Colors, numbers, and color functions; nothing that can reference or load anything. */
const SAFE_VALUE = /^[#a-z0-9 .,%()/+-]+$/i
const FORBIDDEN_VALUE = /url|image|expression|var|attr|env|@|\\/i

/**
 * Extracts allowed token overrides from a theme stylesheet. Later declarations win; unknown
 * tokens and unsafe values are dropped and counted so the host can tell the author.
 */
export function sanitizeThemeCss(css: string): {
  tokens: Partial<Record<ThemeToken, string>>
  ignored: number
} {
  const tokens: Partial<Record<ThemeToken, string>> = {}
  let ignored = 0
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]*)/gi)) {
    const name = match[1].toLowerCase()
    const value = match[2].trim().replace(/\s*!important$/i, '')
    if (
      !ALLOWED.has(name) ||
      value.length === 0 ||
      value.length > 200 ||
      !SAFE_VALUE.test(value) ||
      FORBIDDEN_VALUE.test(value)
    ) {
      ignored += 1
      continue
    }
    tokens[name as ThemeToken] = value
  }
  return { tokens, ignored }
}

export const ACCENT_COLORS = ['blue', 'violet', 'green', 'orange', 'pink'] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]
