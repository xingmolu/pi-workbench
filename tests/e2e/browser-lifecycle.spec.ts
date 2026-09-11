import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BrowserManager, BrowserAgentScope } from '../../src/main/browser-manager'
import type { BrowserOperation, BrowserSnapshotResult } from '../../src/shared/contracts'

type Harness = { manager: BrowserManager; scope: BrowserAgentScope }
let app: ElectronApplication, root: string, server: Server, url: string
const html =
  '<!doctype html><title>Lifecycle</title><style>body{margin:0}button{position:absolute;left:120px;top:90px;width:160px;height:60px}</style><button id="target">Target</button><input aria-label="Name"><script>window.clicks=[];document.querySelector("button").onclick=e=>clicks.push({x:e.clientX,y:e.clientY});</script>'
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-browser-lifecycle-')))
  await Promise.all(
    ['home', 'agent', 'user-data', 'project'].map((name) => mkdir(join(root, name)))
  )
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final' })
      res.end()
      return
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.setHeader('Content-Type', 'text/html')
        res.end(html)
      }, 700)
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(html)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('port')
  url = `http://127.0.0.1:${address.port}`
  app = await electron.launch({
    args: [resolve('.')],
    cwd: join(root, 'project'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  await app.firstWindow()
})
test.afterEach(async () => {
  await app?.close()
  await new Promise<void>((done) => server?.close(() => done()))
  if (root) await rm(root, { recursive: true, force: true })
})
async function setup() {
  expect(
    await app.evaluate(
      async ({ BrowserWindow }, args) => {
        const require = process.getBuiltinModule('module').createRequire(args.module)
        if (!require('node:fs').existsSync(args.module)) return false
        const { BrowserManager } = require(args.module)
        const window = BrowserWindow.getAllWindows()[0]
        const manager: BrowserManager = new BrowserManager(window, () => {})
        manager.setProject(args.project)
        await manager.setView(true, { x: 30, y: 50, width: 800, height: 600 })
        const scope = { owner: {}, projectPath: args.project, sessionId: 'fixture', generation: 1 }
        Object.assign(globalThis, { manager, scope })
        window.show()
        window.focus()
        return true
      },
      { module: resolve('out/main/browser-manager.js'), project: join(root, 'project') }
    ),
    'actual built Main manager module'
  ).toBe(true)
}
async function agent(operation: BrowserOperation) {
  return app.evaluate(async (_electron, operation) => {
    const { manager, scope } = globalThis as unknown as Harness
    try {
      return await manager.executePrepared(
        scope,
        manager.prepare(scope, operation),
        'fixture-' + Math.random()
      )
    } catch (error) {
      return { error: String(error) }
    }
  }, operation)
}
async function script(code: string) {
  return app.evaluate(({ BrowserWindow }, code) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.at(
      -1
    ) as Electron.WebContentsView
    return view.webContents.executeJavaScript(code)
  }, code)
}
async function snapshot() {
  return (await agent({ action: 'snapshot' })) as BrowserSnapshotResult
}
function token(snapshot: BrowserSnapshotResult) {
  return snapshot.text.match(/[0-9a-f-]{36}:1/)![0]
}

test('actual explicit loadURL, redirect, history, reload and managed tab transitions retain only their owner', async () => {
  await setup()
  expect(await agent({ action: 'navigate', url: url + '/first' })).toMatchObject({
    kind: 'action',
    url: url + '/first'
  })
  const first = await snapshot()
  expect(await agent({ action: 'navigate', url: url + '/redirect' })).toMatchObject({
    kind: 'action',
    url: url + '/final'
  })
  expect(await agent({ action: 'click', ref: token(first) })).toHaveProperty('error')
  expect(await agent({ action: 'back' })).toMatchObject({ kind: 'action', url: url + '/first' })
  expect(await agent({ action: 'forward' })).toMatchObject({ kind: 'action', url: url + '/final' })
  expect(await agent({ action: 'reload' })).toMatchObject({ kind: 'action' })
  expect(await agent({ action: 'navigate', url: url + '/final#anchor' })).toMatchObject({
    kind: 'action',
    url: url + '/final#anchor'
  })
  expect(await agent({ action: 'new_tab', url: url + '/second' })).toMatchObject({ kind: 'action' })
  expect(await agent({ action: 'select_tab', pageId: first.pageId })).toMatchObject({
    kind: 'action',
    pageId: first.pageId
  })
  expect(await agent({ action: 'close_tab', pageId: first.pageId })).toMatchObject({
    kind: 'action',
    url: url + '/second'
  })
})

test('actual visible view non-unit zoom sends local DIP input and reports business result and event ordering', async () => {
  await setup()
  expect(await agent({ action: 'navigate', url })).toMatchObject({ kind: 'action' })
  const environment = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0],
      view = window.contentView.children.at(-1) as Electron.WebContentsView
    view.webContents.setZoomFactor(1.25)
    const trace: string[] = []
    const original = view.webContents.sendInputEvent.bind(view.webContents)
    view.webContents.sendInputEvent = (event) => {
      trace.push('send:' + event.type)
      original(event)
      trace.push('return:' + event.type)
    }
    view.webContents.on('before-mouse-event', (_event, input) => trace.push('before:' + input.type))
    view.webContents.on('before-input-event', (_event, input) => trace.push('before:' + input.type))
    Object.assign(globalThis, { trace })
    return {
      focused: window.isFocused(),
      dsf: screen.getDisplayMatching(window.getBounds()).scaleFactor,
      zoom: view.webContents.getZoomFactor(),
      bounds: view.getBounds()
    }
  })
  const observed = await snapshot()
  expect(await agent({ action: 'click', ref: token(observed) })).toMatchObject({ kind: 'action' })
  await expect.poll(() => script('clicks.length')).toBe(1)
  const clicks = await script('clicks')
  expect(clicks).toEqual([{ x: 200, y: 120 }])
  expect(await agent({ action: 'keypress', key: 'a' })).toMatchObject({ kind: 'action' })
  const trace = await app.evaluate(() => (globalThis as unknown as { trace: string[] }).trace)
  test.info().annotations.push({
    type: 'environment',
    description: JSON.stringify({ ...environment, clicks, trace })
  })
  expect(trace).toContain('send:mouseDown')
  console.info(
    'Browser fixture coordinate evidence',
    JSON.stringify({ ...environment, clicks, trace })
  )
  expect(trace.indexOf('before:mouseDown')).toBeGreaterThan(trace.indexOf('send:mouseDown'))
  expect(trace.indexOf('before:mouseDown')).toBeLessThan(trace.indexOf('return:mouseDown'))
  expect(trace.indexOf('before:keyDown')).toBeGreaterThan(trace.indexOf('send:keyDown'))
  expect(trace.indexOf('before:keyDown')).toBeLessThan(trace.indexOf('return:keyDown'))
})

test('user second navigation cancels the first owner and late completion cannot publish over it', async () => {
  await setup()
  expect(
    await app.evaluate(async (_electron, url) => {
      const { manager, scope } = globalThis as unknown as Harness
      const old = manager
        .executePrepared(
          scope,
          manager.prepare(scope, { action: 'navigate', url: url + '/slow' }),
          'old'
        )
        .then(
          () => 'success',
          () => 'stopped'
        )
      const next = await manager.executeUser({ action: 'navigate', url: url + '/new' })
      const outcome = await old
      return { outcome, next, state: manager.getState() }
    }, url)
  ).toMatchObject({
    outcome: 'stopped',
    next: { kind: 'action', url: url + '/new' },
    state: { controller: 'idle', lastAction: '打开网页' }
  })
})

test('actual snapshot refs reject zoom changes, in-page navigation, crash and project change', async () => {
  await setup()
  expect(await agent({ action: 'navigate', url })).toMatchObject({ kind: 'action' })
  const first = await snapshot()
  await app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.at(
      -1
    ) as Electron.WebContentsView
    view.webContents.setZoomFactor(1.25)
  })
  expect(await agent({ action: 'click', ref: token(first) })).toHaveProperty('error')
  const second = await snapshot()
  await script('location.hash = "changed"; true')
  expect(await agent({ action: 'click', ref: token(second) })).toHaveProperty('error')
  const third = await snapshot()
  const outcome = await app.evaluate(async ({ BrowserWindow }, ref) => {
    const { manager, scope } = globalThis as unknown as Harness
    const ticket = manager.prepare(scope, { action: 'click', ref })
    const view = BrowserWindow.getAllWindows()[0].contentView.children.at(
      -1
    ) as Electron.WebContentsView
    const crashed = new Promise<void>((resolve) =>
      view.webContents.once('render-process-gone', () => resolve())
    )
    view.webContents.forcefullyCrashRenderer()
    await crashed
    try {
      await manager.executePrepared(scope, ticket, 'after-crash')
      return 'success'
    } catch {
      return 'rejected'
    }
  }, token(third))
  expect(outcome).toBe('rejected')
  expect(
    await app.evaluate(
      async (_electron, project) => {
        const { manager, scope } = globalThis as unknown as Harness
        const ticket = manager.prepare(scope, { action: 'new_tab' })
        manager.setProject(project)
        try {
          await manager.executePrepared(scope, ticket, 'after-project')
          return 'success'
        } catch {
          return 'rejected'
        }
      },
      join(root, 'other-project')
    )
  ).toBe('rejected')
})

test('actual locate rejects a resized view before input and rejects hidden targets', async () => {
  await setup()
  expect(await agent({ action: 'navigate', url })).toMatchObject({ kind: 'action' })
  const first = await snapshot()
  await app.evaluate(({ BrowserWindow }, module) => {
    const require = process.getBuiltinModule('module').createRequire(module)
    const { BrowserTargets } = require(module)
    const locate = BrowserTargets.prototype.locate
    BrowserTargets.prototype.locate = async function (ref: string) {
      const point = await locate.call(this, ref)
      const view = BrowserWindow.getAllWindows()[0].contentView.children.at(
        -1
      ) as Electron.WebContentsView
      view.setBounds({ x: 30, y: 50, width: 400, height: 300 })
      return point
    }
  }, resolve('out/main/browser-targets.js'))
  expect(await agent({ action: 'click', ref: token(first) })).toHaveProperty('error')
  expect(await script('clicks.length')).toBe(0)
  await app.evaluate(() => (globalThis as unknown as Harness).manager.setView(false))
  expect(await agent({ action: 'snapshot' })).toHaveProperty('error')
})

test('actual view edge target never clamps a rounded out-of-bounds click onto another point', async () => {
  await setup()
  expect(await agent({ action: 'navigate', url })).toMatchObject({ kind: 'action' })
  await script('document.querySelector("button").style.cssText="position:fixed;left:799.5px;top:100px;width:0.5px;height:10px;padding:0;border:0;overflow:hidden"; true')
  const observed = await snapshot()
  expect(await agent({ action: 'click', ref: token(observed) })).toHaveProperty('error')
  expect(await script('clicks.length')).toBe(0)
})
