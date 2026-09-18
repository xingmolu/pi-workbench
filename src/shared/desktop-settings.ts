import { z } from 'zod'

export const DESKTOP_SETTINGS_CHANNEL = 'pi:desktop-settings'
export const desktopSettingsSchema = z.strictObject({
  // Missing in older preference files: preserve the existing dark appearance.
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  messageFontSize: z.number().int().min(13).max(18),
  codeFontSize: z.number().int().min(11).max(16),
  codeWrap: z.boolean(),
  reducedMotion: z.boolean(),
  sendShortcut: z.enum(['enter', 'modifier-enter']),
  workDetails: z.enum(['compact', 'expanded']),
  showUsage: z.boolean()
})
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>
export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: 'system',
  messageFontSize: 15,
  codeFontSize: 13,
  codeWrap: false,
  reducedMotion: false,
  sendShortcut: 'enter',
  workDetails: 'compact',
  showUsage: false
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
