import { openWorkbenchTool } from './workbench-helpers'
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

test('top-right toggle never overlaps a native window drag rectangle', async () => {
  // CDP clicks can bypass macOS non-client hit testing. Check the actual drag
  // geometry as well, so a passing DOM click cannot hide an unclickable titlebar.
  for (const width of [960, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
    for (const open of [false, true]) {
      const toggle = page.locator('.workbench-toggle')
      if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', String(open))
      await expect.poll(() => page.evaluate(() => {
        const button = document.querySelector('.workbench-toggle')!.getBoundingClientRect()
        return [...document.querySelectorAll<HTMLElement>('*')].filter(element => {
          if (getComputedStyle(element).getPropertyValue('-webkit-app-region') !== 'drag') return false
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top
        }).map(element => element.className)
      })).toEqual([])
    }
  }
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
    await openWorkbenchTool(page, '浏览器')
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
  await openWorkbenchTool(page, '终端')
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
  await expect.poll(width).toBeCloseTo(0, 0)
  await openWorkbenchTool(page, '终端')
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
    await openWorkbenchTool(page, kind === 'browser' ? '浏览器' : 'Resize 沙箱')
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
    await page.getByRole('button', { name: '打开工具', exact: true }).click()
    await expect.poll(async () => (await info())?.visible).toBe(false)
    await expect(page.getByRole('menuitem', { name: '文件', exact: true })).toBeVisible()
    await page.screenshot({ path: `artifacts/e2e/workbench-menu-${kind}.png` })
    await page.getByRole('menuitem', { name: '文件', exact: true }).click()
    await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await openWorkbenchTool(page, kind === 'browser' ? '浏览器' : 'Resize 沙箱')
    await expect.poll(async () => (await info())?.visible).toBe(true)
    expect((await info())!.id).toBe(original.id)
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
    await openWorkbenchTool(page, kind === 'browser' ? '浏览器' : 'Resize 沙箱')
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

test('pruning the last open tab dismisses its menu and a browser opened from the launcher is visible', async () => {
  await openWorkbenchTool(page, 'Resize 沙箱')
  await page.getByRole('button', { name: '打开工具', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '浏览器', exact: true })).toBeVisible()
  await page.evaluate(() =>
    window.pi.workbench({
      type: 'plugin:set-enabled',
      pluginId: 'example.resize',
      desktopEnabled: false
    })
  )
  await expect(page.getByRole('navigation', { name: '打开工作台工具' })).toBeVisible()
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await openWorkbenchTool(page, '浏览器')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.pi.browser({ type: 'state:get' })).state.visible)
    )
    .toBe(true)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow, WebContentsView }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.some(
          (child) =>
            child instanceof WebContentsView &&
            child.webContents.getURL() === 'about:blank' &&
            child.getVisible()
        )
      )
    )
    .toBe(true)
})

test('a large registry stays scrollable in a short window and keyboard selection reaches its last tool', async () => {
  const manifestPath = join(root, 'agent/desktop-plugins/resize-plugin/pi-desktop.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const title = '长名称工具'.repeat(12)
  manifest.contributes.workbench = Array.from({ length: 40 }, (_, index) => ({
    id: `example.resize.tool${index}`,
    title: `${index} ${title}`,
    icon: 'flask',
    activation: 'onApp',
    surface: { kind: 'sandboxed-web', entry: './index.html' }
  }))
  await writeFile(manifestPath, JSON.stringify(manifest))
  await page.evaluate(() => window.pi.workbench({ type: 'plugins:reload' }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
  await expect
    .poll(() => launcher.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  const last = launcher.getByRole('button', { name: `39 ${title}`, exact: true })
  await last.focus()
  await expect(last).toBeInViewport()
  await last.press('Enter')
  await page.getByRole('button', { name: '打开工具', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect
    .poll(() => menu.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await page.keyboard.press('End')
  const lastOption = page.getByRole('menuitem', { name: `39 ${title}`, exact: true })
  await expect(lastOption).toBeFocused()
  await expect(lastOption).toBeInViewport()
  await lastOption.press('Enter')
  await expect(page.getByRole('tab', { name: `39 ${title}`, exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('empty launcher, tabs, close and reopen preserve workbench state at 960px', async () => {
  const width = () => page.locator('.workbench').evaluate((el) => el.getBoundingClientRect().width)
  await expect.poll(width).toBe(0)
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '打开工作台工具' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: '已打开的工作台工具' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开工具', exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'artifacts/e2e/workbench-launcher.png' })
  await openWorkbenchTool(page, '终端')
  await page.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  const terminalId = await page
    .locator('.terminal-session:not([hidden])')
    .getAttribute('data-terminal-id')
  await page.getByRole('button', { name: '关闭终端标签', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '打开工作台工具' })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: '打开工作台工具' }).getByRole('button').first()
  ).toBeFocused()
  await openWorkbenchTool(page, '终端')
  await expect(page.locator('.terminal-session:not([hidden])')).toHaveAttribute(
    'data-terminal-id',
    terminalId!
  )
  await openWorkbenchTool(page, '文件')
  const filesTab = page.getByRole('tab', { name: '文件', exact: true })
  await filesTab.focus()
  await filesTab.press('Home')
  await expect(page.getByRole('tab', { name: '终端', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(filesTab).toBeFocused()
  await expect(
    page.getByRole('tablist', { name: '已打开的工作台工具' }).getByRole('tab')
  ).toHaveCount(2)
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()
  await expect.poll(width).toBe(0)
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900))
  await page.screenshot({ path: 'artifacts/e2e/workbench-tabs-960.png' })
})

test('delayed menu focus restoration does not override newer tool tab focus', async () => {
  await openWorkbenchTool(page, '文件')
  await page.getByRole('button', { name: '打开工具', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '打开工具', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '打开工具', exact: true }).click()
  // Exercise the real Radix unmount event with a newer focus choice immediately
  // before its delayed restoration callback, rather than relying on timer luck.
  await page.getByRole('menu').evaluate((menu) => {
    menu.addEventListener('focusScope.autoFocusOnUnmount', () => {
      document.getElementById('workbench-tab-works.pi.desktop.files')?.focus()
      queueMicrotask(() => { document.documentElement.dataset.menuFocusSettled = 'true' })
    }, { once: true })
  })
  await page.getByRole('menuitem', { name: '终端', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-menu-focus-settled', 'true')
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toBeFocused()
})
