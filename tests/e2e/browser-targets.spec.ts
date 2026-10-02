import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BrowserTargets } from '../../src/main/browser-targets'
import { displayEnv } from './display-env'

let app: ElectronApplication
let root: string
let server: Server
let url: string
type Harness = { targets: BrowserTargets; view: Electron.WebContentsView }

async function pageScript(code: string): Promise<unknown> {
  return app.evaluate(
    (_electron, script) =>
      (globalThis as unknown as Harness).view.webContents.executeJavaScript(script),
    code
  )
}
async function snapshot() {
  return app.evaluate(() => (globalThis as unknown as Harness).targets.snapshot())
}
async function locate(token: string) {
  return app.evaluate(async (_electron, ref) => {
    try {
      return await (globalThis as unknown as Harness).targets.locate(ref)
    } catch (error) {
      return { error: String(error) }
    }
  }, token)
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-browser-targets-')))
  await Promise.all(
    ['home', 'agent', 'user-data', 'project'].map((name) => mkdir(join(root, name)))
  )
  server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(
      '<!doctype html><title>Fixture</title><button id="one">One</button><button id="two">Two</button><input aria-label="Name"><select aria-label="Choice"><option>A</option><option>B</option></select>'
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  url = `http://127.0.0.1:${address.port}/`
  app = await electron.launch({
    args: [resolve('.')],
    cwd: join(root, 'project'),
    env: {
      ...displayEnv(),
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
  const available = await app.evaluate(
    async ({ BrowserWindow, WebContentsView }, args) => {
      const require = process.getBuiltinModule('module').createRequire(args.adapter)
      const fs = require('node:fs')
      if (!fs.existsSync(args.adapter)) return false
      const { BrowserTargets } = require(args.adapter)
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: 'browser-targets-fixture'
        }
      })
      BrowserWindow.getAllWindows()[0].contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      await view.webContents.loadURL(args.url)
      Object.assign(globalThis, { view, targets: new BrowserTargets(view.webContents) })
      return true
    },
    { adapter: resolve('out/main/browser-targets.js'), url }
  )
  expect(available, 'Actual built BrowserTargets adapter must exist').toBe(true)
}

test('isolated registry persists, resists page monkeypatching, and revokes old snapshot/navigation tokens', async () => {
  await setup()
  const first = await snapshot()
  const token = first.items[0].token
  expect(await pageScript(`typeof globalThis.__piBrowserTargets`)).toBe('undefined')
  await pageScript(
    `globalThis.__piBrowserTargets = { compromised: true }; Element.prototype.getBoundingClientRect = () => { throw Error('page poison') }; true`
  )
  expect(await locate(token)).toMatchObject({ nonce: first.nonce })
  const second = await snapshot()
  expect(second.nonce).not.toBe(first.nonce)
  expect(await locate(token)).toHaveProperty('error')
  await app.evaluate(
    (_electron, next) => (globalThis as unknown as Harness).view.webContents.loadURL(next),
    url + '?next'
  )
  expect(await locate(second.items[0].token)).toHaveProperty('error')
})

test('document.open retaining the original root still revokes tokens', async () => {
  await setup()
  const first = await snapshot()
  expect(
    await pageScript(
      `(() => { const root = document.documentElement; const old = document.getElementById('one'); document.open(); document.append(root); document.close(); return document.documentElement === root && old.isConnected; })()`
    )
  ).toBe(true)
  expect(await locate(first.items[0].token)).toHaveProperty('error')
})

test('identity survives reorder but replacement, semantic reuse, detached and adopted nodes are stale', async () => {
  await setup()
  let state = await snapshot()
  await pageScript(`document.body.append(document.getElementById('one')); true`)
  expect(await locate(state.items[0].token)).toMatchObject({ nonce: state.nonce })
  await pageScript(
    `document.getElementById('one').outerHTML = '<button id="one">One</button>'; true`
  )
  expect(await locate(state.items[0].token)).toHaveProperty('error')
  for (const mutation of [
    `document.getElementById('one').textContent = 'Changed'`,
    `document.getElementById('one').remove()`,
    `document.implementation.createHTMLDocument().adoptNode(document.getElementById('one'))`
  ]) {
    await pageScript(`document.body.innerHTML = '<button id="one">One</button>'; true`)
    state = await snapshot()
    await pageScript(`${mutation}; true`)
    expect(await locate(state.items[0].token)).toHaveProperty('error')
  }
})

test('fill/select enforce current state and work despite default world setter/event poison', async () => {
  await setup()
  const state = await snapshot()
  const input = state.items.find((item) => item.name === 'Name')!.token
  const select = state.items.find((item) => item.name === 'Choice')!.token
  async function action(method: 'fill' | 'select', token: string, value: string) {
    return app.evaluate(
      async (_electron, args) => {
        try {
          await (globalThis as unknown as Harness).targets[args.method](args.token, args.value)
          return true
        } catch (error) {
          return String(error)
        }
      },
      { method, token, value }
    )
  }
  await pageScript(
    `window.events = []; document.querySelector('input').addEventListener('input', () => events.push('input')); document.querySelector('input').addEventListener('change', () => events.push('change')); Object.defineProperty(HTMLInputElement.prototype, 'value', { set() { throw Error('poison') } }); window.Event = window.InputEvent = window.MutationObserver = function() { throw Error('poison') }; true`
  )
  expect(await action('fill', input, 'hello')).toBe(true)
  expect(await pageScript('JSON.stringify(events)')).toBe('["input","change"]')
  expect(await action('select', select, 'B')).toBe(true)
  await pageScript(
    `document.querySelector('input').readOnly = true; document.querySelector('select').disabled = true; true`
  )
  expect(await action('fill', input, 'bad')).not.toBe(true)
  expect(await action('select', select, 'A')).not.toBe(true)
  await pageScript(
    `document.querySelector('input').readOnly = false; document.querySelector('input').disabled = true; true`
  )
  expect(await action('fill', input, 'bad')).not.toBe(true)
})

for (const mutation of ['this.contentEditable = "false"', 'this.style.display = "none"']) {
  test(`fill rechecks editability after focus handler: ${mutation}`, async () => {
    await setup()
    await pageScript(
      `document.body.innerHTML = '<div contenteditable="true" aria-label="Editor">Original</div>'; document.querySelector('div').addEventListener('focus', function() { ${mutation} }); true`
    )
    const state = await snapshot()
    const rejected = await app.evaluate(async (_electron, token) => {
      try {
        await (globalThis as unknown as Harness).targets.fill(token, 'Changed')
        return false
      } catch {
        return true
      }
    }, state.items[0].token)
    expect(rejected).toBe(true)
    expect(await pageScript(`document.querySelector('div').textContent`)).toBe('Original')
  })
}

for (const multiple of [false, true]) {
  test(`select changes the validated duplicate-value option (multiple=${multiple})`, async () => {
    await setup()
    await pageScript(
      `document.body.innerHTML = '<select aria-label="Choice" ${multiple ? 'multiple' : ''}><option value="same" disabled>A</option><option value="same">B</option><option selected>C</option></select>'; true`
    )
    const state = await snapshot()
    await app.evaluate(
      (_electron, token) => (globalThis as unknown as Harness).targets.select(token, 'B'),
      state.items[0].token
    )
    expect(
      await pageScript(
        `(() => { const select = document.querySelector('select'); return { index: select.selectedIndex, selected: Array.from(select.options, option => option.selected) }; })()`
      )
    ).toEqual({ index: 1, selected: [false, true, false] })
  })
}

test('locate rejects current disabled and overlay; invalidation/disposal revoke capabilities', async () => {
  await setup()
  let state = await snapshot()
  await pageScript(`document.getElementById('one').disabled = true; true`)
  expect(await locate(state.items[0].token)).toHaveProperty('error')
  await pageScript(
    `document.getElementById('one').disabled = false; document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;z-index:9999"></div>'); true`
  )
  expect(await locate(state.items[0].token)).toHaveProperty('error')
  await app.evaluate(() => (globalThis as unknown as Harness).targets.invalidate())
  expect(await locate(state.items[0].token)).toHaveProperty('error')
  state = await snapshot()
  await app.evaluate(() => (globalThis as unknown as Harness).targets.dispose())
  expect(await locate(state.items[0].token)).toHaveProperty('error')
})

test('snapshots bound traversal/text and publish only whole element rows', async () => {
  await setup()
  await pageScript(
    `document.body.innerHTML = '<p>' + 'x'.repeat(9000) + '</p>' + Array.from({length:200}, (_,i) => '<a href="/' + 'z'.repeat(1000) + '">Link' + i + '</a>').join(''); true`
  )
  const state = await snapshot()
  expect(state.incomplete).toBe(true)
  expect(state.content.length).toBeLessThanOrEqual(6000)
  expect(state.text.length).toBeLessThanOrEqual(20000)
  expect(state.text).toContain('[Snapshot incomplete]')
  for (const item of state.items) expect(state.text).toContain(JSON.stringify(item) + '\n')
  expect(await locate(`${state.nonce}:${state.items.length + 1}`)).toHaveProperty('error')
})

test('snapshot does not publish input values and bounds deep names and document traversal', async () => {
  await setup()
  await pageScript(
    `document.body.innerHTML = '<input type="password" value="fixture-secret"><input value="private-text"><button>' + '<span>x</span>'.repeat(5000) + '</button><button>Outside traversal budget</button>'; true`
  )
  const state = await snapshot()
  expect(state.text).not.toContain('fixture-secret')
  expect(state.text).not.toContain('private-text')
  expect(state.items.map((item) => item.name)).not.toContain('Outside traversal budget')
  expect(state.incomplete).toBe(true)
})

test('body-only truncation marks the snapshot incomplete', async () => {
  await setup()
  await pageScript(`document.body.textContent = 'x'.repeat(6001); true`)
  const state = await snapshot()
  expect(state.content).toHaveLength(6000)
  expect(state.incomplete).toBe(true)
  expect(state.text).toContain('[Snapshot incomplete]')
})

test('semantic href/type changes and unsupported controls cannot reuse a capability', async () => {
  await setup()
  await pageScript(
    `document.body.innerHTML = '<a href="/first">Link</a><input aria-label="Text"><input type="checkbox" aria-label="Check"><select aria-label="Select"><option>A</option><option disabled>B</option></select>'; true`
  )
  const state = await snapshot()
  await pageScript(
    `document.querySelector('a').href = '/second'; document.querySelector('input').type = 'button'; true`
  )
  expect(await locate(state.items[0].token)).toHaveProperty('error')
  expect(await locate(state.items[1].token)).toHaveProperty('error')
  const rejected = await app.evaluate(
    async (_electron, tokens) => {
      const targets = (globalThis as unknown as Harness).targets
      return Promise.all(
        [
          targets.fill(tokens[2], 'text'),
          targets.select(tokens[3], 'B'),
          targets.select(tokens[3], 'Missing')
        ].map((promise) =>
          promise.then(
            () => false,
            () => true
          )
        )
      )
    },
    state.items.map((item) => item.token)
  )
  expect(rejected).toEqual([true, true, true])
})

test('private identity rejects href suffix and resolved base destination changes', async () => {
  await setup()
  await pageScript(
    `document.body.innerHTML = '<a href="/' + 'x'.repeat(1100) + 'first">Link</a>'; true`
  )
  let state = await snapshot()
  expect(state.items).toHaveLength(1)
  await pageScript(
    `document.querySelector('a').setAttribute('href', '/' + 'x'.repeat(1100) + 'second'); true`
  )
  expect.soft(await locate(state.items[0].token)).toHaveProperty('error')
  await pageScript(
    `document.head.insertAdjacentHTML('beforeend', '<base href="/first/">'); document.querySelector('a').setAttribute('href', 'target'); true`
  )
  state = await snapshot()
  await pageScript(`document.querySelector('base').href = '/second/'; true`)
  expect(await locate(state.items[0].token)).toHaveProperty('error')
})

test('private identity rejects long explicit name/role suffix changes and declines oversized metadata', async () => {
  await setup()
  for (const attribute of ['aria-label', 'role']) {
    await pageScript(
      `document.body.innerHTML = '<button>Button</button>'; document.querySelector('button').setAttribute('${attribute}', 'x'.repeat(300) + 'first'); true`
    )
    const state = await snapshot()
    expect(state.items).toHaveLength(1)
    await pageScript(
      `document.querySelector('button').setAttribute('${attribute}', 'x'.repeat(300) + 'second'); true`
    )
    expect.soft(await locate(state.items[0].token)).toHaveProperty('error')
  }
  await pageScript(
    `document.body.innerHTML = '<a href="/' + 'x'.repeat(9000) + '">Large URL</a><button aria-label="' + 'x'.repeat(9000) + '">Large name</button>'; true`
  )
  const state = await snapshot()
  expect(state.items).toHaveLength(0)
  expect(state.incomplete).toBe(true)
})

test('document.open retaining and reinserting the original node revokes its token', async () => {
  await setup()
  const first = await snapshot()
  expect(
    await pageScript(
      `(() => { const old = document.getElementById('one'); const doc = document; document.open(); document.write('<!doctype html><body>replacement</body>'); document.close(); document.body.append(old); return old.ownerDocument === doc && old.isConnected; })()`
    )
  ).toBe(true)
  expect(await locate(first.items[0].token)).toHaveProperty('error')
})
