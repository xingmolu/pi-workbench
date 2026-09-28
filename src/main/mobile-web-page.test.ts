import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MOBILE_PAGE_CSP,
  mobileAsset,
  mobileManifest,
  mobilePageHtml,
  mobileRootFile
} from './mobile-web-page'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mobile-web-'))
  dirs.push(dir)
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'mobile.html'), '<div id="app"></div>')
  await writeFile(join(dir, 'assets', 'mobile-abc123.js'), 'export {}')
  await writeFile(join(dir, 'secret.txt'), 'nope')
  await writeFile(join(dir, 'mobile-sw.js'), 'self')
  return dir
}

it('serves the built page and only hashed assets of known types from assets/', async () => {
  const dir = await root()
  expect(await mobilePageHtml(dir)).toContain('id="app"')
  expect(await mobilePageHtml(join(dir, 'missing'))).toBeNull()
  const asset = await mobileAsset('/assets/mobile-abc123.js', dir)
  expect(asset?.type).toContain('javascript')
  expect(asset?.body.toString()).toBe('export {}')
  for (const path of [
    '/assets/../secret.txt',
    '/assets/%2e%2e/secret.txt',
    '/assets/.hidden.js',
    '/assets/missing.js',
    '/assets/mobile-abc123.exe',
    '/secret.txt'
  ])
    expect(await mobileAsset(path, dir)).toBeNull()
})

it('locks the page to its own origin', () => {
  expect(MOBILE_PAGE_CSP).toContain("script-src 'self'")
  expect(MOBILE_PAGE_CSP).not.toContain("script-src 'self' 'unsafe-inline'")
  expect(MOBILE_PAGE_CSP).toContain("connect-src 'self'")
  expect(MOBILE_PAGE_CSP).toContain("frame-ancestors 'none'")
  expect(JSON.parse(mobileManifest()).start_url).toBe('/')
})

it('serves only the named root files: the service worker and the icon', async () => {
  const dir = await root()
  expect((await mobileRootFile('/sw.js', dir))?.type).toContain('javascript')
  expect(await mobileRootFile('/icon.png', dir)).toBeNull()
  for (const path of ['/secret.txt', '/mobile-sw.js', '/constructor', '/__proto__'])
    expect(await mobileRootFile(path, dir)).toBeNull()
  const manifest = JSON.parse(mobileManifest())
  expect(manifest.icons.every((icon: { src: string }) => icon.src === '/icon.png')).toBe(true)
})
