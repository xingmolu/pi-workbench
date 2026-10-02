import { z } from 'zod'
import { ACCENT_COLORS } from './theme-tokens'
import { LANGUAGE_SETTINGS } from './i18n'

export const DESKTOP_SETTINGS_CHANNEL = 'pi:desktop-settings'
export const desktopSettingsSchema = z.strictObject({
  // Missing in older preference files: preserve the existing dark appearance.
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  accent: z.enum(ACCENT_COLORS).default('blue'),
  /** A plugin theme (`<plugin id>/<theme id>`); `theme` then holds its light/dark base. */
  pluginTheme: z.string().min(3).max(300).nullable().default(null),
  messageFontSize: z.number().int().min(13).max(18),
  codeFontSize: z.number().int().min(11).max(16),
  codeWrap: z.boolean(),
  reducedMotion: z.boolean(),
  sendShortcut: z.enum(['enter', 'modifier-enter']),
  workDetails: z.enum(['compact', 'expanded']),
  showUsage: z.boolean(),
  /** Interface language; `system` follows the computer. Applied after a restart. */
  language: z.enum(LANGUAGE_SETTINGS).default('system')
})
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>
export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: 'system',
  accent: 'blue',
  pluginTheme: null,
  messageFontSize: 15,
  codeFontSize: 13,
  codeWrap: false,
  reducedMotion: false,
  sendShortcut: 'enter',
  workDetails: 'compact',
  showUsage: false,
  language: 'system'
}
export const desktopSettingsCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get') }),
  z.strictObject({ type: z.literal('save'), settings: desktopSettingsSchema }),
  z.strictObject({ type: z.literal('reset') })
])
export type DesktopSettingsCommand = z.infer<typeof desktopSettingsCommandSchema>

export function shouldSendOnKey(
  event: {
    key: string
    shiftKey: boolean
    metaKey: boolean
    ctrlKey: boolean
    keyCode: number
    isComposing: boolean
  },
  shortcut: DesktopSettings['sendShortcut']
): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    (shortcut === 'enter' || event.metaKey || event.ctrlKey)
  )
}
