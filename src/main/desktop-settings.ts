import {
  DEFAULT_DESKTOP_SETTINGS,
  desktopSettingsCommandSchema,
  desktopSettingsSchema,
  type DesktopSettings
} from '../shared/desktop-settings'

export function handleDesktopSettings(
  store: {
    get(key: 'desktopSettings'): unknown
    set(key: 'desktopSettings', value: DesktopSettings): void
    delete(key: 'desktopSettings'): void
  },
  command: unknown
): DesktopSettings {
  const request = desktopSettingsCommandSchema.parse(command)
  if (request.type === 'reset') store.delete('desktopSettings')
  if (request.type === 'save') {
    store.set('desktopSettings', request.settings)
    return desktopSettingsSchema.parse(request.settings)
  }
  const parsed = desktopSettingsSchema.safeParse(store.get('desktopSettings'))
  return parsed.success ? parsed.data : { ...DEFAULT_DESKTOP_SETTINGS }
}
