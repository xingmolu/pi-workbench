import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, site: Server
const clicks: { x: number; y: number; width: number }[] = []

/** The page a developer would check from their phone: a button, a long body, its width. */
const HTML = `<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0;font:16px sans-serif;height:3000px">
<button id="go" style="position:absolute;left:0;top:0;width:200px;height:100px">Tap me</button>
<script>
document.getElementById('go').addEventListener('click', (e) => {
  fetch('/clicked?x=' + e.clientX + '&y=' + e.clientY + '&w=' + innerWidth)
})
</script></body>`

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as { port: number }).port
  await new Promise((done) => probe.close(done))
  return port
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-remote-browser-')))
  const project = join(root, 'shop')
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(root, 'agent'), { recursive: true })
  ])
  clicks.length = 0
  site = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/clicked') {
      clicks.push({
        x: Number(url.searchParams.get('x')),
        y: Number(url.searchParams.get('y')),
        width: Number(url.searchParams.get('w'))
      })
      response.end('ok')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(HTML)
  })
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
      ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      PI_DESKTOP_E2E_MOBILE_PORT: String(await freePort())
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
})

test.afterEach(async () => {
  await page?.evaluate(() => window.pi.mobileGateway({ type: 'stop' })).catch(() => undefined)
  await app?.close()
  await new Promise((done) => site?.close(done))
  if (root) await rm(root, { recursive: true, force: true })
})

/** Reads server-sent events from the gateway the way the phone page does. */
function events(response: Response): { next(name: string): Promise<unknown>; stop(): void } {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const queue: { event: string; data: unknown }[] = []
  let stopped = false
  const pump = async (): Promise<void> => {
    while (!stopped) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event && data) queue.push({ event, data: JSON.parse(data) })
      }
    }
  }
  void pump()
  return {
    async next(name) {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const index = queue.findIndex((item) => item.event === name)
        if (index >= 0) return queue.splice(0, index + 1).at(-1)!.data
        await new Promise((done) => setTimeout(done, 50))
      }
      throw new Error(`no ${name} event`)
    },
    stop() {
      stopped = true
      void reader.cancel().catch(() => undefined)
    }
  }
}

test('a paired phone watches, taps and resizes the desktop browser through the gateway', async () => {
  const state = await page.evaluate(async () => {
    await window.pi.mobileGateway({ type: 'remote-views', access: 'control' })
    return window.pi.mobileGateway({ type: 'pairing:create' })
  })
  expect(state.error).toBeNull()
  expect(state.remoteViews).toBe('control')
  const gateway = state.loopbackUrl!.replace(/\/$/, '')
  const paired = await fetch(`${gateway}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: state.pairing!.token, deviceName: 'e2e phone' })
  })
  const { deviceToken } = (await paired.json()) as { deviceToken: string }
  const headers = { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' }
  // Like the phone's list: the browser is usable once the desktop has the project open.
  await expect
    .poll(async () => {
      const views = await (await fetch(`${gateway}/api/views`, { headers })).json()
      return views.views.find((view: { id: string }) => view.id === 'browser')?.live
    })
    .toBe(true)

  // Watching reveals the desktop browser panel, which is what lets it render.
  const stream = events(await fetch(`${gateway}/api/views/browser/events`, { headers }))
  await expect(page.getByRole('button', { name: '后退' }).first()).toBeVisible()
  const input = (body: unknown): Promise<Response> =>
    fetch(`${gateway}/api/views/browser/input`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`
  const navigated = await input({ type: 'navigate', url })
  expect(navigated.status, await navigated.clone().text()).toBe(200)
  await expect
    .poll(async () => {
      const next = (await stream.next('state')) as { tabs: { url: string; active: boolean }[] }
      return next.tabs.find((tab) => tab.active)?.url
    })
    .toBe(url)
  const frame = (await stream.next('frame')) as { data: string; width: number; height: number }
  expect(frame.width).toBeGreaterThan(390)
  expect(Buffer.from(frame.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))

  // A tap in frame coordinates is a real click on the page.
  expect((await input({ type: 'tap', x: 50, y: 40 })).status).toBe(200)
  await expect.poll(() => clicks.length).toBe(1)
  expect(clicks[0]).toMatchObject({ x: 50, y: 40 })

  // Phone-sized: the page lays out at 390 CSS pixels and frames follow.
  expect((await input({ type: 'device', mobile: true })).status).toBe(200)
  await expect.poll(async () => ((await stream.next('frame')) as { width: number }).width).toBe(390)
  expect((await input({ type: 'tap', x: 20, y: 20 })).status).toBe(200)
  await expect.poll(() => clicks.length).toBe(2)
  expect(clicks[1]).toMatchObject({ x: 20, y: 20, width: 390 })
  await page.screenshot({ path: resolve('artifacts/e2e/desktop-remote-browser-mobile.png') })

  // View-only refuses input; turning remote views off ends the stream.
  await page.evaluate(() => window.pi.mobileGateway({ type: 'remote-views', access: 'view' }))
  expect((await input({ type: 'tap', x: 20, y: 20 })).status).toBe(403)
  await page.evaluate(() => window.pi.mobileGateway({ type: 'remote-views', access: 'off' }))
  expect((await fetch(`${gateway}/api/views/browser/events`, { headers })).status).toBe(403)
  stream.stop()
})
