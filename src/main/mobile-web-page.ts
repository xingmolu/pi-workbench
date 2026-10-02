import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { languageTag, locale, t } from '../shared/i18n'

/** The mobile page is a built Vite entry next to the desktop renderer (out/renderer). */
export const MOBILE_WEB_ROOT = resolve(__dirname, '../renderer')

export const MOBILE_PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  json: 'application/json; charset=utf-8'
}

export function mobileManifest(): string {
  return JSON.stringify({
    id: '/',
    name: t('Pi 远程对话'),
    short_name: 'Pi',
    description: t('在手机上继续 Pi Desktop 的对话'),
    display: 'standalone',
    start_url: '/',
    scope: '/',
    background_color: '#0b0b0c',
    theme_color: '#0b0b0c',
    lang: languageTag(),
    icons: [
      { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' }
    ]
  })
}

/** Top-level files the page needs outside assets/: its service worker and home-screen icon. */
const ROOT_FILES: Record<string, { file: string; type: string }> = {
  '/sw.js': { file: 'mobile-sw.js', type: 'text/javascript; charset=utf-8' },
  '/icon.png': { file: 'mobile-icon.png', type: 'image/png' }
}

export async function mobileRootFile(
  pathname: string,
  root = MOBILE_WEB_ROOT
): Promise<{ body: Buffer; type: string } | null> {
  const entry = Object.hasOwn(ROOT_FILES, pathname) ? ROOT_FILES[pathname] : undefined
  if (!entry) return null
  try {
    return { body: await readFile(join(root, entry.file)), type: entry.type }
  } catch {
    return null
  }
}

/** Shown when the renderer was never built, e.g. a dev run before `npm run build`. */
export function mobileUnavailableHtml(): string {
  return t(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Pi 远程对话</title><body style="font:15px -apple-system,system-ui,sans-serif;padding:24px;color:#888">手机页面尚未构建。请先运行 npm run build，再刷新此页。</body></html>'
  )
}

export async function mobilePageHtml(root = MOBILE_WEB_ROOT): Promise<string | null> {
  try {
    const html = await readFile(join(root, 'mobile.html'), 'utf8')
    // The phone page follows the desktop's interface language; its scripts read the meta tag.
    return html
      .replace('<html lang="zh-CN">', `<html lang="${languageTag()}">`)
      .replace('<head>', `<head>\n    <meta name="pi-locale" content="${locale()}" />`)
      .replace('<title>Pi 远程对话</title>', `<title>${t('Pi 远程对话')}</title>`)
  } catch {
    return null
  }
}

/** A hashed build asset under `assets/`, or null. Never serves anything outside it. */
export async function mobileAsset(
  pathname: string,
  root = MOBILE_WEB_ROOT
): Promise<{ body: Buffer; type: string } | null> {
  const match = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(pathname)
  if (!match || match[1]!.startsWith('.')) return null
  const type = TYPES[match[1]!.split('.').pop()!.toLowerCase()]
  if (!type) return null
  const base = resolve(root, 'assets')
  const file = resolve(base, match[1]!)
  if (!file.startsWith(base + sep)) return null
  try {
    if (!(await stat(file)).isFile()) return null
    return { body: await readFile(file), type }
  } catch {
    return null
  }
}
