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
import { openWorkbenchTool } from './workbench-helpers'

let app: ElectronApplication
let page: Page
let root: string
let project: string
let offpage: string
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-global-navigation-')))
  project = join(root, 'project')
  for (const name of ['home', 'agent', 'data', 'project', 'empty-recent'])
    await mkdir(join(root, name))
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await mkdir(join(root, 'agent/extensions'))
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(root, 'agent/auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(root, 'agent/extensions/fixture.ts'),
    `import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve(aiRoot, pkg.exports['.'].import))}; export default function(pi) { const faux = fauxProvider({ provider: 'fixture', api: 'fixture-api', models: [{ id: 'offline' }], tokensPerSecond: 10 }); faux.setResponses([fauxAssistantMessage('忙碌响应 '.repeat(500))]); pi.registerProvider(faux.provider); }`
  )
  const plugin = join(root, 'agent/desktop-plugins/search-fixture')
  await mkdir(plugin, { recursive: true })
  await writeFile(
    join(plugin, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example.search',
      version: '1.0.0',
      name: 'Search fixture',
      engines: { piDesktop: '^0.1.0' },
      permissions: [],
      contributes: {
        workbench: [
          {
            id: 'example.search.main',
            title: '搜索沙箱',
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
    '<!doctype html><title>Search plugin</title><input value="保留插件内容">'
  )
  const bucket = join(
    root,
    'agent/sessions',
    `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  await mkdir(bucket, { recursive: true })
  for (let index = 0; index < 55; index++) {
    const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 86400000).toISOString()
    const path = join(bucket, `saved-${index}.jsonl`)
    const name = index === 0 ? '离页中文 Needle' : `最近会话 ${index}`
    const entries = [
      { type: 'session', version: 3, id: `saved-${index}`, timestamp, cwd: project },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp,
        provider: 'fixture',
        modelId: 'offline'
      },
      {
        type: 'thinking_level_change',
        id: 'thinking',
        parentId: 'model',
        timestamp,
        thinkingLevel: 'off'
      },
      {
        type: 'message',
        id: 'user-1',
        parentId: 'thinking',
        timestamp,
        message: {
          role: 'user',
          content: [{ type: 'text', text: name }],
          timestamp: Date.parse(timestamp)
        }
      },
      {
        type: 'message',
        id: 'answer-1',
        parentId: 'user-1',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Canonical fixture answer' }],
          api: 'openai-responses',
          provider: 'fixture',
          model: 'offline',
          stopReason: 'stop',
          timestamp: Date.parse(timestamp),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
      },
      { type: 'session_info', id: 'name', parentId: 'answer-1', timestamp, name }
    ]
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    if (index === 0) offpage = path
  }
  await writeFile(
    join(root, 'data/pi-desktop-preferences.json'),
    JSON.stringify({ recentProjects: [join(root, 'empty-recent')] })
  )
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      PATH: process.env.PATH ?? '',
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
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
  await expect(page.locator('.conversation-session-title')).toHaveText('最近会话 54')
})

test('new chat picks exact empty recent cwd and Files action focuses the existing file search', async () => {
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await page.getByRole('option', { name: /新建会话/ }).click()
  const picker = page.getByRole('combobox', { name: '搜索已有项目' })
  await picker.fill('empty-recent')
  await expect(page.getByRole('option', { name: /empty-recent/ })).toHaveCount(1)
  await picker.press('Enter')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).project?.path))
    .toBe(join(root, 'empty-recent'))
  expect(
    (await page.evaluate(() => window.pi.getState())).nodes.filter(
      (node) => node.type === 'user' || node.type === 'assistant'
    )
  ).toEqual([])
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await page.getByRole('option', { name: /搜索文件/ }).click()
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByRole('textbox', { name: '搜索文件名' })).toBeFocused()
  await page.keyboard.type('file')
  await expect(page.getByRole('textbox', { name: '搜索文件名' })).toHaveValue('file')
  await expect(page.getByText('没有匹配的文件', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '搜索文件名' })).toBeFocused()
  expect(
    (await page.evaluate(() => window.pi.getState())).nodes.filter(
      (node) => node.type === 'user' || node.type === 'assistant'
    )
  ).toEqual([])
})

test('IME and conflicting dialogs ignore CmdK; Escape restores focus and obsolete search cannot navigate', async () => {
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务' })
  await expect(draft).toBeEnabled()
  await draft.focus()
  await draft.dispatchEvent('compositionstart')
  await draft.press('Meta+k')
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toHaveCount(0)
  await draft.dispatchEvent('compositionend')
  await draft.press('Meta+k')
  const input = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await input.fill('中文')
  await expect(page.getByRole('option', { name: /离页中文/ })).toBeVisible()
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  await input.press('Escape')
  await expect(input).toBeVisible()
  await input.dispatchEvent('compositionend')
  const source = await page.evaluate(() => window.pi.getState())
  await input.fill('没有结果')
  await input.press('Enter')
  await expect(page.getByRole('option', { name: /离页中文/ })).toHaveCount(0)
  await input.press('Escape')
  await expect(draft).toBeFocused()
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(source.sessionId)
  await draft.press('Meta+k')
  await expect(input).toHaveValue('')
  await expect(page.getByRole('option', { name: /最近会话 54/ })).toBeVisible()
  await input.press('ArrowDown')
  await expect(page.getByRole('option', { name: /最近会话 53/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await input.press('ArrowUp')
  await expect(page.getByRole('option', { name: /最近会话 54/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await input.press('Escape')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toHaveCount(0)
})

test('busy search remains read-only and can navigate while the source keeps running', async () => {
  const source = await page.evaluate(() => window.pi.getState())
  await page.evaluate(
    async (source) =>
      window.pi.send({
        type: 'prompt:send',
        sessionId: source.sessionId!,
        generation: source.generation,
        text: '开始慢速回答'
      }),
    source
  )
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  const before = await readFile(offpage, 'utf8')
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await expect(page.getByRole('option', { name: /新建会话/ })).toHaveAttribute(
    'aria-disabled',
    'false'
  )
  const input = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await input.fill('中文')
  await expect(page.getByRole('option', { name: /离页中文/ })).toHaveAttribute(
    'aria-disabled',
    'false'
  )
  expect(await readFile(offpage, 'utf8')).toBe(before)
  await input.press('Enter')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeSessionPath))
    .toBe(offpage)
  const rejected = await page.evaluate(
    async ({ source, cwd, path }) => {
      try {
        await window.pi.send(
          {
            type: 'project:navigate',
            cwd,
            sessionPath: path,
            sessionId: source.sessionId,
            generation: source.generation
          },
          source.desktopScope
            ? {
                scope: source.desktopScope,
                sessionId: source.sessionId,
                generation: source.generation
              }
            : undefined
        )
        return false
      } catch {
        return true
      }
    },
    { source, cwd: project, path: offpage }
  )
  expect(rejected).toBe(true)
  await page.evaluate(
    (workerId) => window.pi.selectSession(workerId),
    source.desktopScope!.workerId
  )
  expect((await page.evaluate(() => window.pi.getState())).busy).toBe(true)
  await page.evaluate(() => window.pi.send({ type: 'prompt:abort' }))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
})

test('palette hides native Browser without destroying identity, restores bounds, and fits 960/1440', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await openWorkbenchTool(page, '浏览器')
  const browser = () =>
    page.evaluate(async () => (await window.pi.browser({ type: 'state:get' })).state)
  await expect.poll(async () => (await browser()).visible).toBe(true)
  const before = await browser()
  const views = () =>
    app.evaluate(({ BrowserWindow, WebContentsView }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter(
          (view) => view instanceof WebContentsView && view.webContents.getURL() === 'about:blank'
        )
        .map((view) => ({
          id: (view as InstanceType<typeof WebContentsView>).webContents.id,
          bounds: view.getBounds()
        }))
    )
  const nativeBefore = await views()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
  await page.locator('.browser-viewport').screenshot()
  const viewportAt960 = (await page.locator('.browser-viewport').boundingBox())!
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440)
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  const input = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await expect(input).toBeVisible()
  await expect.poll(async () => (await browser()).visible).toBe(false)
  for (const width of [1440, 960]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width
    )
    await input.fill('中文')
    await expect(page.getByRole('option', { name: /离页中文/ })).toBeVisible()
    const box = (await page.getByRole('dialog', { name: '搜索与快捷操作' }).boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(20)
    expect(box.x + box.width).toBeLessThanOrEqual(width - 20)
    await page.screenshot({ path: resolve(`artifacts/e2e/global-navigation-${width}.png`) })
  }
  await input.press('Escape')
  await expect.poll(async () => (await browser()).visible).toBe(true)
  expect((await browser()).activePageId).toBe(before.activePageId)
  expect((await views()).map((view) => view.id)).toEqual(nativeBefore.map((view) => view.id))
  const restored = (await views())[0].bounds
  expect(restored.width).toBeGreaterThan(0)
  await expect
    .poll(async () => {
      const bounds = (await views())[0].bounds
      const rect = (await page.locator('.browser-viewport').boundingBox())!
      return [
        bounds.x - Math.round(rect.x),
        bounds.y - Math.round(rect.y),
        bounds.width - Math.round(rect.width),
        bounds.height - Math.round(rect.height)
      ]
    })
    .toEqual([0, 0, 0, 0])
  await test.info().attach('native-bounds-before-after', {
    body: JSON.stringify({
      beforePaletteAt960: viewportAt960,
      restoredAt960: (await views())[0].bounds
    }),
    contentType: 'application/json'
  })
})

test('native focused Browser CmdK opens the palette (requires OS window focus)', async () => {
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
          (view) => view instanceof WebContentsView && view.webContents.getURL() === 'about:blank'
        )
      )
    )
    .toBe(true)
  const id = await app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (view) => view instanceof WebContentsView && view.webContents.getURL() === 'about:blank'
    ) as InstanceType<typeof WebContentsView>
    return view.webContents.id
  })
  await app.evaluate(({ app, BrowserWindow, WebContentsView }) => {
    const window = BrowserWindow.getAllWindows()[0]
    app.focus({ steal: true })
    window.focus()
    const view = window.contentView.children.find(
      (view) => view instanceof WebContentsView && view.webContents.getURL() === 'about:blank'
    ) as InstanceType<typeof WebContentsView>
    view.webContents.focus()
  })
  const focused = await expect
    .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), id), {
      timeout: 1500
    })
    .toBe(true)
    .then(
      () => true,
      () => false
    )
  test.skip(
    !focused,
    'macOS did not grant native window focus; focused native CmdK needs an unlocked interactive desktop'
  )
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)!
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['meta'] })
  }, id)
  const input = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await expect(input).toBeVisible()
  await input.press('Escape')
  await expect
    .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), id))
    .toBe(true)
})

test('sandboxed plugin view identity and live document survive the palette and settings', async () => {
  await openWorkbenchTool(page, '搜索沙箱')
  const info = () =>
    app.evaluate(({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          child instanceof WebContentsView && child.webContents.getURL().includes('search-fixture')
      )
      return view instanceof WebContentsView
        ? { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds() }
        : null
    })
  await expect.poll(async () => (await info())?.visible).toBe(true)
  const before = (await info())!
  await app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id)!.executeJavaScript('window.paletteSentinel = "retained"'),
    before.id
  )
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await expect.poll(async () => (await info())?.visible).toBe(false)
  await page.getByRole('combobox', { name: '搜索所有会话标题' }).press('Escape')
  await expect.poll(async () => (await info())?.visible).toBe(true)
  expect(await info()).toEqual(before)
  expect(
    await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.paletteSentinel'),
      before.id
    )
  ).toBe('retained')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(async () => (await info())?.visible).toBe(false)
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭设置' }).click()
  await expect.poll(async () => (await info())?.visible).toBe(true)
  expect((await info())?.id).toBe(before.id)
})

test('isolated delayed search cannot replace newer results or survive a source generation change', async () => {
  const source = await page.evaluate(() => window.pi.getState())
  const original = await page.evaluate(() =>
    window.pi.send({ type: 'session:search', query: '中文', limit: 50 })
  )
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle('pi:command', (_event, command) => {
      if (command.type !== 'session:search')
        return {
          kind: 'project-catalog',
          catalog: { projects: [], totalProjects: 0, truncated: false }
        }
      if (command.query === 'old')
        return new Promise((resolve) => ipcMain.once('search:release-old', () => resolve(result)))
      return {
        ...result,
        result: {
          ...result.result,
          items: result.result.items.map((item) => ({ ...item, title: '新查询结果' }))
        }
      }
    })
  }, original)
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  const input = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await input.fill('old')
  await expect
    .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount('search:release-old')))
    .toBe(1)
  await input.fill('new')
  await expect(page.getByRole('option', { name: /新查询结果/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await app.evaluate(({ ipcMain }) => ipcMain.emit('search:release-old'))
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(page.getByRole('option', { name: /新查询结果/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByRole('option', { name: /离页中文/ })).toHaveCount(0)
  await input.fill('old')
  await expect
    .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount('search:release-old')))
    .toBe(1)
  await app.evaluate(
    ({ BrowserWindow }, snapshot) =>
      BrowserWindow.getAllWindows()[0].webContents.send('pi:event', {
        type: 'event',
        event: 'snapshot',
        data: { ...snapshot, generation: snapshot.generation + 1, revision: snapshot.revision + 1 }
      }),
    source
  )
  await expect(input).toHaveCount(0)
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await expect(input).toHaveValue('')
  await expect(page.getByRole('option', { name: /新查询结果/ })).toBeVisible()
  await app.evaluate(({ ipcMain }) => ipcMain.emit('search:release-old'))
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(input).toBeVisible()
  await expect(page.getByRole('option', { name: /离页中文/ })).toHaveCount(0)
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(source.sessionId)
})

test('isolated search failure is distinct from no matches and retry restores results without navigation', async () => {
  const original = await page.evaluate(() =>
    window.pi.send({ type: 'session:search', query: '中文', limit: 50 })
  )
  const source = await page.evaluate(() => window.pi.getState())
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('pi:command')
    let fail = true
    ipcMain.handle('pi:command', () => {
      if (fail) {
        fail = false
        throw new Error('fixture read failed')
      }
      return result
    })
  }, original)
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await expect(page.getByText('目录暂时不可读取，请重试。')).toBeVisible()
  await expect(page.getByText('没有匹配的会话标题', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('option', { name: /离页中文/ })).toBeVisible()
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(source.sessionId)
})

test('pending search preserves a keyboard-selected quick action when session results arrive', async () => {
  const original = await page.evaluate(() =>
    window.pi.send({ type: 'session:search', query: '中文', limit: 50 })
  )
  const source = await page.evaluate(() => window.pi.getState())
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle('pi:command', (_event, command) => {
      if (command.type === 'session:search')
        return new Promise((resolve) =>
          ipcMain.once('search:release-actions', () => resolve(result))
        )
      throw new Error('Unexpected navigation from the selected quick action')
    })
  }, original)
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  const input = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await expect
    .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount('search:release-actions')))
    .toBe(1)
  await expect(page.getByRole('option', { name: /新建会话/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  await expect(page.getByRole('option', { name: /搜索文件/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await app.evaluate(({ ipcMain }) => ipcMain.emit('search:release-actions'))
  await expect(page.getByRole('option', { name: /离页中文/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /搜索文件/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await input.press('Enter')
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByRole('textbox', { name: '搜索文件名' })).toBeFocused()
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(source.sessionId)
})
test.afterEach(async () => {
  if (app?.process().exitCode === null) await app.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('global Chinese title search opens canonical off-page identity and preserves drafts', async () => {
  const before = await readFile(offpage, 'utf8')
  await expect(
    page.locator('.project-session-row').filter({ hasText: '离页中文 Needle' })
  ).toHaveCount(0)
  await page.getByRole('textbox', { name: '给 Pi 的任务' }).fill('保留来源草稿')
  const source = await page.evaluate(() => window.pi.getState())
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  const search = page.getByRole('combobox', { name: '搜索所有会话标题' })
  await search.fill('中文 needle')
  await expect(page.getByRole('option', { name: /离页中文 Needle/ })).toBeVisible()
  await search.press('Enter')
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeSessionPath))
    .toBe(offpage)
  expect((await readFile(offpage, 'utf8')).startsWith(before)).toBe(true)
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await search.fill('最近会话 54')
  await expect(page.getByRole('option', { name: /最近会话 54/ })).toBeVisible()
  await search.press('Enter')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeSessionPath))
    .toBe(source.activeSessionPath)
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务' })).toHaveValue('保留来源草稿')
})
