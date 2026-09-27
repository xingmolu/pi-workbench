import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalWorkbenchPanelFile,
  isPotentialWorkbenchPanelNavigation,
  secureWorkbenchPanelResponseHeaders,
  STRICT_WORKBENCH_PANEL_CSP
} from './workbench-panel-security'

describe('Workbench panel file security', () => {
  let fixtureDirectory: string
  let canonicalRootPath: string
  let entryPath: string
  let assetPath: string
  let outsidePath: string

  beforeEach(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'pi-workbench-security-'))
    const rootPath = join(fixtureDirectory, 'plugin root 你好')
    const assetsPath = join(rootPath, 'assets')
    entryPath = join(rootPath, 'index file.html')
    assetPath = join(assetsPath, '图标.svg')
    outsidePath = join(fixtureDirectory, 'outside.txt')
    await mkdir(assetsPath, { recursive: true })
    await writeFile(entryPath, '<!doctype html>')
    await writeFile(assetPath, '<svg/>')
    await writeFile(outsidePath, 'secret')
    await symlink(outsidePath, join(rootPath, 'linked-secret.txt'))
    canonicalRootPath = await realpath(rootPath)
    entryPath = join(canonicalRootPath, 'index file.html')
    assetPath = join(canonicalRootPath, 'assets', '图标.svg')
  })

  afterEach(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true })
  })

  it('accepts canonical regular entry and asset files inside the plugin root', async () => {
    await expect(
      canonicalWorkbenchPanelFile(pathToFileURL(entryPath).href, canonicalRootPath)
    ).resolves.toBe(await realpath(entryPath))
    await expect(
      canonicalWorkbenchPanelFile(pathToFileURL(assetPath).href, canonicalRootPath)
    ).resolves.toBe(await realpath(assetPath))
  })

  it('rejects the root itself and directories', async () => {
    await expect(
      canonicalWorkbenchPanelFile(pathToFileURL(canonicalRootPath).href, canonicalRootPath)
    ).resolves.toBeNull()
    await expect(
      canonicalWorkbenchPanelFile(
        pathToFileURL(join(canonicalRootPath, 'assets')).href,
        canonicalRootPath
      )
    ).resolves.toBeNull()
  })

  it('decodes URL-encoded spaces and Unicode without weakening containment', async () => {
    const entryUrl = pathToFileURL(entryPath).href
    const assetUrl = pathToFileURL(assetPath).href
    expect(entryUrl).toContain('%20')
    expect(assetUrl).toMatch(/%[0-9A-F]{2}/)

    await expect(canonicalWorkbenchPanelFile(entryUrl, canonicalRootPath)).resolves.toBe(
      await realpath(entryPath)
    )
    await expect(canonicalWorkbenchPanelFile(assetUrl, canonicalRootPath)).resolves.toBe(
      await realpath(assetPath)
    )
  })

  it('rejects encoded traversal and encoded path separators', async () => {
    const rootUrl = pathToFileURL(`${canonicalRootPath}/`).href

    await expect(
      canonicalWorkbenchPanelFile(`${rootUrl}%2e%2e/outside.txt`, canonicalRootPath)
    ).resolves.toBeNull()
    await expect(
      canonicalWorkbenchPanelFile(`${rootUrl}assets%2F..%2Foutside.txt`, canonicalRootPath)
    ).resolves.toBeNull()
  })

  it('rejects a symlink that escapes the canonical plugin root', async () => {
    await expect(
      canonicalWorkbenchPanelFile(
        pathToFileURL(join(canonicalRootPath, 'linked-secret.txt')).href,
        canonicalRootPath
      )
    ).resolves.toBeNull()
  })

  it.each([
    'https://example.com/a.js',
    'http://example.com/',
    'data:text/html,test',
    'ftp://example.com/file.txt',
    '::::'
  ])('rejects non-local or malformed URL %s', async (url) => {
    await expect(canonicalWorkbenchPanelFile(url, canonicalRootPath)).resolves.toBeNull()
  })

  it('lexically prefilters navigation without accepting roots, traversal, or other protocols', () => {
    expect(
      isPotentialWorkbenchPanelNavigation(pathToFileURL(entryPath).href, canonicalRootPath)
    ).toBe(true)
    expect(
      isPotentialWorkbenchPanelNavigation(pathToFileURL(assetPath).href, canonicalRootPath)
    ).toBe(true)
    expect(
      isPotentialWorkbenchPanelNavigation(pathToFileURL(canonicalRootPath).href, canonicalRootPath)
    ).toBe(false)
    const rootUrl = pathToFileURL(`${canonicalRootPath}/`).href
    expect(
      isPotentialWorkbenchPanelNavigation(`${rootUrl}%2e%2e/outside.txt`, canonicalRootPath)
    ).toBe(false)
    expect(
      isPotentialWorkbenchPanelNavigation(`${rootUrl}assets%2Ficon.svg`, canonicalRootPath)
    ).toBe(false)
    expect(isPotentialWorkbenchPanelNavigation('https://example.com/', canonicalRootPath)).toBe(
      false
    )
    expect(isPotentialWorkbenchPanelNavigation('data:text/html,test', canonicalRootPath)).toBe(
      false
    )
    expect(isPotentialWorkbenchPanelNavigation('::::', canonicalRootPath)).toBe(false)
  })
})

describe('Workbench panel response security', () => {
  it('replaces an existing CSP while preserving unrelated headers and enforcing host policies', () => {
    const original = {
      'content-security-policy': ['default-src *; connect-src https:'],
      'X-Content-Type-Options': ['unsafe-value'],
      'referrer-policy': ['unsafe-url'],
      'Cache-Control': ['no-cache']
    }

    expect(secureWorkbenchPanelResponseHeaders(original)).toEqual({
      'Cache-Control': ['no-cache'],
      'Content-Security-Policy': [STRICT_WORKBENCH_PANEL_CSP],
      'X-Content-Type-Options': ['nosniff'],
      'Referrer-Policy': ['no-referrer']
    })
    expect(original['content-security-policy']).toEqual(['default-src *; connect-src https:'])
    expect(STRICT_WORKBENCH_PANEL_CSP).toContain("default-src 'none'")
    expect(STRICT_WORKBENCH_PANEL_CSP).toContain("connect-src 'none'")
    expect(STRICT_WORKBENCH_PANEL_CSP).toContain("frame-ancestors 'none'")
    const compat = secureWorkbenchPanelResponseHeaders({}, { inlineScripts: true })[
      'Content-Security-Policy'
    ][0]
    expect(compat).toContain("script-src 'self' 'unsafe-inline'")
    expect(compat).toContain("connect-src 'none'")
    expect(compat).toContain("default-src 'none'")
  })
})
