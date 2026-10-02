// Explicit extensions: some shared modules are also loaded directly by Node in tests.
import { en } from './en.ts'

/**
 * Interface language. Chinese is the source language: every string in the code is written in
 * Chinese and passed through `t()`, which looks it up in the catalog for the current locale and
 * falls back to the Chinese source when a translation is missing.
 */
export const LOCALES = ['zh-CN', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const LANGUAGE_SETTINGS = ['system', ...LOCALES] as const
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number]

/** Set by Main when it starts an engine host, so host messages match the window language. */
export const LOCALE_ENV = 'PI_DESKTOP_LOCALE'

const catalogs: Record<Locale, Readonly<Record<string, string>>> = { 'zh-CN': {}, en }

/**
 * Each process finds its language before any of its modules build strings: engine hosts from
 * the environment Main gives them, the desktop window from its preload, the phone page from a
 * meta tag Main writes into it. Main itself sets it from `locale-boot`.
 */
function initialLocale(): Locale {
  const scope = globalThis as {
    process?: { env?: Record<string, string | undefined> }
    pi?: { locale?: unknown }
    document?: {
      querySelector?: (selector: string) => { getAttribute(name: string): string | null } | null
    }
  }
  const candidates = [
    scope.process?.env?.[LOCALE_ENV],
    scope.pi?.locale,
    scope.document?.querySelector?.('meta[name="pi-locale"]')?.getAttribute('content')
  ]
  return candidates.find(isLocale) ?? 'zh-CN'
}

let current: Locale = initialLocale()

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function setLocale(locale: Locale): void {
  current = locale
}

export function locale(): Locale {
  return current
}

/** `system` follows the first preferred language: Chinese for any zh-*, English otherwise. */
export function resolveLocale(
  setting: LanguageSetting | undefined,
  preferred: readonly string[]
): Locale {
  if (setting && setting !== 'system') return setting
  const first = preferred.find(Boolean)?.toLowerCase() ?? 'zh-cn'
  return first.startsWith('zh') ? 'zh-CN' : 'en'
}

/**
 * Translates a Chinese source string. `{name}` placeholders are filled from `values`, so word
 * order can change between languages: `t('共 {count} 个文件', { count })`.
 */
export function t(
  source: string,
  values?: Readonly<Record<string, string | number | null | undefined>>
): string {
  const text = catalogs[current][source] ?? source
  if (!values) return text
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match
  )
}

/** The BCP 47 tag for `Intl` formatting and the document's `lang`. */
export function languageTag(value: Locale = current): string {
  return value === 'en' ? 'en' : 'zh-CN'
}
