import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication
let page: Page
let root: string
test.beforeEach(async () => {
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-workbench-resize-')))
  for (const dir of ['home', 'agent', 'data', 'project']) await mkdir(join(root, dir))
  await mkdir(join(root, 'agent/extensions'))
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(root, 'agent/auth.json'),
    JSON.stringify({ 'resize-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(root, 'agent/extensions/fixture.ts'),
    `
    import { fauxProvider } from ${JSON.stringify(resolve(aiRoot, pkg.exports['.'].import))};
    export default function(pi) {
      pi.registerProvider(fauxProvider({ provider: 'resize-fixture', api: 'resize-fixture-api', models: [{ id: 'offline' }] }).provider);
    }
  `
  )
  const plugin = join(root, 'agent/desktop-plugins/resize-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(
    join(plugin, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example.resize',
      version: '1.0.0',
      name: 'Resize fixture',
      engines: { piDesktop: '^0.1.0' },
      permissions: [],
      contributes: {
        workbench: [
          {
            id: 'example.resize.main',
            title: 'Resize 沙箱',
            icon: 'flask',
            activation: 'onApp',
            surface: { kind: 'sandboxed-web', entry: './index.html' }
          }
        ]
      }
    })
  )
  await writeFile(
    join(plugin, 'index.html'),
    '<!doctype html><title>Resize plugin</title><input aria-label="Plugin draft" value="plugin state survives">'
  )
  app = await electron.launch({
    args: [resolve('.')],
    cwd: join(root, 'project'),
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'resize-fixture', modelId: 'offline' })
  )
})
test.afterEach(async () => {
  if (app?.process().exitCode === null) await app.close()
  if (root) await rm(root, { recursive: true, force: true })
})

for (const pointer of ['fine', 'coarse'] as const) {
  test(`${pointer} pointer edge starts suspend native views across the full library hit target`, async () => {
    if (pointer === 'coarse') {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await page.reload()
      await expect
        .poll(() => page.evaluate(async () => (await window.pi.getState()).ready))
        .toBe(true)
    }
    expect(await page.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(
      pointer === 'coarse'
    )
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await page.getByRole('button', { name: '浏览器', exact: true }).click()
    const visible = () =>
      page.evaluate(async () => (await window.pi.browser({ type: 'state:get' })).state.visible)
    await expect.poll(visible).toBe(true)
    await expect
      .poll(() =>
        page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeCloseTo(412, 0)
    const handle = page.getByRole('separator', { name: '调整工作台宽度' })
    for (const side of [-1, 1]) {
      const box = (await handle.boundingBox())!
      const outset = pointer === 'coarse' ? 5 : 0.5
      const x = side < 0 ? box.x - outset : box.x + box.width + outset
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('[data-slot="resizable-handle"]')?.className,
          { x, y: box.y + box.height / 2 }
        )
      ).toBe('workspace-resize-handle')
      await page.mouse.move(x, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(x + 25, box.y + box.height / 2)
      await expect.poll(visible, { timeout: 2000 }).toBe(false)
      await page.mouse.up()
      await expect.poll(visible).toBe(true)
      await expect.poll(async () => (await handle.boundingBox())!.x).toBeGreaterThan(box.x + 10)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
    expect(
      await page.locator('.composer').evaluate(
        (composer, outset) => {
          const handle = document.querySelector('.workspace-resize-handle')!.getBoundingClientRect()
          return composer.getBoundingClientRect().right <= handle.left - outset
        },
        pointer === 'coarse' ? 6 : 1
      )
    ).toBe(true)
  })
}

test('mouse and keyboard resizing preserve draft and terminal through fold and window resize', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.getByRole('button', { name: '终端', exact: true }).click()
  const handle = page.getByRole('separator', { name: '调整工作台宽度' })
  await expect(handle).toBeVisible()
  await page.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  const terminal = page.locator('.terminal-session:not([hidden])')
  const terminalId = await terminal.getAttribute('data-terminal-id')
  const input = terminal.locator('.xterm-helper-textarea')
  await input.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', "printf '%s_%s\\n' 'RESIZE' $$")
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
  })
  await input.press('Enter')
  await expect(terminal.locator('.xterm-rows')).toContainText(/RESIZE_\d+/)
  const pid = (await terminal.locator('.xterm-rows').innerText()).match(/RESIZE_(\d+)/)![1]
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.fill('resize preserves this draft')
  const width = () => page.locator('.workbench').evaluate((el) => el.getBoundingClientRect().width)
  const initial = await width()
  expect(initial).toBeCloseTo(412, 0)
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect.poll(width).toBeGreaterThan(initial + 80)
  const dragged = await width()
  await handle.focus()
  await handle.press('ArrowRight')
  await expect.poll(width).toBeLessThan(dragged - 5)
  const remembered = await width()
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()
  await expect.poll(width).toBeCloseTo(52, 0)
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await expect.poll(width).toBeCloseTo(remembered, 0)
  await expect(draft).toHaveValue('resize preserves this draft')
  await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  for (const size of [1440, 960]) {
    await app.evaluate(
      ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 900),
      size
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size)
    await expect
      .poll(() => page.locator('.conversation').evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThanOrEqual(419)
    await expect(draft).toHaveValue('resize preserves this draft')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal.locator('.xterm-rows')).toContainText(`RESIZE_${pid}`)
    for (const selector of ['.model-chip', '.send']) {
      await expect(page.locator(selector)).toBeEnabled()
      expect(
        await page.locator(selector).evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const composer = element.closest('.composer')!.getBoundingClientRect()
          return bounds.left >= composer.left && bounds.right <= composer.right
        })
      ).toBe(true)
    }
    await page.screenshot({ path: `artifacts/e2e/workbench-resize-${size}.png` })
  }
})

test('native browser and sandbox views suspend during drag and keep identity, state and modal visibility', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  for (const kind of ['browser', 'plugin'] as const) {
    await page
      .getByRole('button', { name: kind === 'browser' ? '浏览器' : 'Resize 沙箱', exact: true })
      .click()
    const handle = page.getByRole('separator', { name: '调整工作台宽度' })
    await handle.focus()
    await handle.press('Home')
    const info = () =>
      app.evaluate(({ BrowserWindow, WebContentsView }, isPlugin) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
          (child) =>
            child instanceof WebContentsView &&
            (isPlugin
              ? child.webContents.getURL().includes('resize-plugin')
              : child.webContents.getURL() === 'about:blank')
        )
        if (!(view instanceof WebContentsView)) return null
        return { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds() }
      }, kind === 'plugin')
    await expect.poll(async () => (await info())?.visible).toBe(true)
    const original = (await info())!
    await app.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('window.resizeSentinel = "retained"'),
      original.id
    )
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // Move over the native viewport's former area; it must not consume pointer events.
    await page.mouse.move(box.x + 70, box.y + box.height / 2)
    await expect.poll(async () => (await info())?.visible).toBe(false)
    await page.mouse.up()
    await expect.poll(async () => (await info())?.visible).toBe(true)
    const viewport = page.locator(
      kind === 'browser' ? '.browser-viewport' : '.sandboxed-plugin-pane'
    )
    const rendererBounds = () =>
      viewport.evaluate((element) => {
        const r = element.getBoundingClientRect()
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      })
    await expect
      .poll(
        async () =>
          JSON.stringify((await info())?.bounds) === JSON.stringify(await rendererBounds())
      )
      .toBe(true)
    expect((await info())!.bounds.width).toBeLessThan(original.bounds.width - 30)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect.poll(async () => (await info())?.visible).toBe(false)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await info())?.visible).toBe(true)
    await page.getByRole('button', { name: '折叠工作台', exact: true }).click()
    await expect.poll(async () => (await info())?.visible).toBe(false)
    await page
      .getByRole('button', { name: kind === 'browser' ? '浏览器' : 'Resize 沙箱', exact: true })
      .click()
    await expect.poll(async () => (await info())?.visible).toBe(true)
    expect((await info())!.id).toBe(original.id)
    expect(
      await app.evaluate(
        ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.resizeSentinel'),
        original.id
      )
    ).toBe('retained')
    await page.keyboard.press('Meta+b')
    await expect
      .poll(
        async () =>
          JSON.stringify((await info())?.bounds) === JSON.stringify(await rendererBounds())
      )
      .toBe(true)
    await page.keyboard.press('Meta+b')
    await expect
      .poll(
        async () =>
          JSON.stringify((await info())?.bounds) === JSON.stringify(await rendererBounds())
      )
      .toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
    await expect
      .poll(
        async () =>
          JSON.stringify((await info())?.bounds) === JSON.stringify(await rendererBounds())
      )
      .toBe(true)
    await expect.poll(async () => (await info())?.visible).toBe(true)
    const nativeScreenshot = await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)!
      await contents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
      )
      return (await contents.capturePage()).toPNG().toString('base64')
    }, original.id)
    await writeFile(
      resolve(`artifacts/e2e/workbench-resize-${kind}-native-960.png`),
      Buffer.from(nativeScreenshot, 'base64')
    )
    const screenshot = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')
    )
    await writeFile(
      resolve(`artifacts/e2e/workbench-resize-${kind}-960.png`),
      Buffer.from(screenshot, 'base64')
    )
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  }
})
