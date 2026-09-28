import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

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
    name: 'Pi 远程对话',
    short_name: 'Pi',
    display: 'standalone',
    start_url: '/',
    background_color: '#0b0b0c',
    theme_color: '#0b0b0c',
    lang: 'zh-CN'
  })
}

/** Shown when the renderer was never built, e.g. a dev run before `npm run build`. */
export function mobileUnavailableHtml(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Pi 远程对话</title><body style="font:15px -apple-system,system-ui,sans-serif;padding:24px;color:#888">手机页面尚未构建。请先运行 npm run build，再刷新此页。</body></html>`
}

export async function mobilePageHtml(root = MOBILE_WEB_ROOT): Promise<string | null> {
  try {
    return await readFile(join(root, 'mobile.html'), 'utf8')
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
