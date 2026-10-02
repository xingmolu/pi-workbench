/**
 * Decides the interface language before any other Main module loads, so strings built at
 * import time are already in that language; engine and plugin hosts inherit it through the
 * environment. Imported first by Main's entry. A change takes effect after a restart.
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LANGUAGE_SETTINGS,
  LOCALE_ENV,
  isLocale,
  resolveLocale,
  setLocale,
  type LanguageSetting,
  type Locale
} from '../shared/i18n'

function savedLanguage(userData: string): LanguageSetting | undefined {
  try {
    const stored = JSON.parse(readFileSync(join(userData, 'pi-desktop-preferences.json'), 'utf8'))
    const value = stored?.desktopSettings?.language
    return (LANGUAGE_SETTINGS as readonly string[]).includes(value) ? value : undefined
  } catch {
    return undefined
  }
}

function preferredLanguages(): string[] {
  try {
    return app.getPreferredSystemLanguages()
  } catch {
    return [process.env.LC_ALL || process.env.LANG || ''].filter(Boolean)
  }
}

export function bootLocale(): Locale {
  const e2e = process.env.PI_DESKTOP_E2E === '1'
  const userData = e2e ? process.env.PI_DESKTOP_E2E_USER_DATA : app.getPath('userData')
  const setting = userData ? savedLanguage(userData) : undefined
  // End-to-end specs are written against the Chinese interface unless they ask otherwise.
  const e2eLocale = process.env.PI_DESKTOP_E2E_LOCALE
  const locale =
    e2e && (!setting || setting === 'system')
      ? isLocale(e2eLocale)
        ? e2eLocale
        : 'zh-CN'
      : resolveLocale(setting, preferredLanguages())
  process.env[LOCALE_ENV] = locale
  setLocale(locale)
  return locale
}

bootLocale()
