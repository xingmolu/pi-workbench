import { expect, it } from 'vitest'
import { resolveTheme } from './theme'
import { readFileSync } from 'node:fs'

it.each([
  ['dark', true, 'dark'], ['dark', false, 'dark'],
  ['light', true, 'light'], ['light', false, 'light'],
  ['system', true, 'dark'], ['system', false, 'light']
] as const)('resolves %s with system dark=%s as %s', (preference, systemDark, expected) => {
  expect(resolveTheme(preference, systemDark)).toBe(expected)
})

it('keeps light-theme primary, secondary and status text at readable contrast', () => {
  const css = readFileSync(new URL('../assets/theme.css', import.meta.url), 'utf8').split(":root[data-theme='light']")[1]
  const colors = Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/g)].map(match => [match[1], match[2]]))
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  for (const [foreground, background] of [
    ['--text', '--canvas'], ['--text-soft', '--raised'], ['--muted', '--raised'],
    ['--muted-2', '--composer'], ['--sidebar-secondary', '--sidebar-selected'],
    ['--warning-text', '--warning-bg'], ['--danger-text', '--danger-bg'],
    ['--success-text', '--raised'], ['--accent-text', '--accent-soft']
  ]) {
    const a = luminance(colors[foreground]), b = luminance(colors[background])
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
  }
})
