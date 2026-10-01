import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

let app: ElectronApplication, page: Page, root: string, server: Server
const artifacts = resolve('artifacts/e2e/engine-download')

function tarEntry(name: string, content: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100)
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('        ', 148)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding])
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-engine-download-')))
  await Promise.all([
    mkdir(join(root, 'agent'), { recursive: true }),
    mkdir(join(root, 'user-data')),
    mkdir(join(root, 'home')),
    mkdir(artifacts, { recursive: true })
  ])
  // A stand-in CLI, padded so the download takes long enough to watch.
  const archive = gzipSync(
    Buffer.concat([
      tarEntry('package/claude', Buffer.from('#!/bin/sh\necho stand-in\n'), 0o755),
      tarEntry('package/padding.bin', Buffer.alloc(24 * 1024, 7), 0o644),
      Buffer.alloc(1024)
    ]),
    { level: 0 }
  )
  const body = archive
  server = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    for (let index = 0; index < body.length; index += 128) {
      response.write(body.subarray(index, index + 128))
      await new Promise((done) => setTimeout(done, 25))
    }
    response.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const pins = {
    claude: {
      version: '9.9.9',
      platforms: {
        [`${process.platform}-${process.arch}`]: {
          tarball: `http://127.0.0.1:${port}/claude.tgz`,
          integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
          size: body.length,
          root: 'package/',
          executable: process.platform === 'win32' ? 'claude.exe' : 'claude'
        }
      }
    },
    codex: { version: '0.0.0', platforms: {} }
  }
  await writeFile(join(root, 'pins.json'), JSON.stringify(pins))
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
      ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      PI_DESKTOP_E2E_ENGINE_PINS: join(root, 'pins.json'),
      PI_DESKTOP_E2E_NO_BUNDLED_ENGINES: '1'
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
})

test.afterEach(async () => {
  await app?.close()
  await new Promise((done) => server?.close(done))
  if (root) await rm(root, { recursive: true, force: true })
})

test('Claude Code downloads on demand, verified against its pin, and can be removed', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const engines = page.getByRole('radiogroup', { name: '新会话默认引擎' })
  await expect(engines.getByRole('radio', { name: /Claude Code/ })).toContainText('未下载')
  const downloads = page.getByRole('group', { name: '引擎下载' })
  await expect(downloads).toContainText('首次使用需要下载')
  await page.screenshot({ path: join(artifacts, 'missing.png') })

  await downloads.getByRole('button', { name: '下载', exact: true }).click()
  await expect(downloads.getByRole('progressbar', { name: 'Claude Code 下载进度' })).toBeVisible()
  await expect(engines.getByRole('radio', { name: /Claude Code/ })).toContainText('下载中')
  await page.screenshot({ path: join(artifacts, 'downloading.png') })
  await expect(downloads).toContainText('已下载 9.9.9', { timeout: 30000 })
  expect(
    await page.evaluate(
      async () =>
        (await window.pi.runtimeAccounts()).find((engine) => engine.runtimeId === 'claude')?.binary
    )
  ).toMatchObject({ state: 'ready', source: 'downloaded' })

  page.once('dialog', (dialog) => void dialog.accept())
  await downloads.getByRole('button', { name: '删除', exact: true }).click()
  await expect(downloads).toContainText('首次使用需要下载')
})
