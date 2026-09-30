import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const artifacts = resolve('artifacts/e2e/bundled-host-plugins')
let app: ElectronApplication, page: Page, root: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-browser-plugin-')))
  const project = join(root, 'shop')
  const agent = join(root, 'agent')
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, pkg.exports['.'].import)
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ 'browser-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider:'browser-fixture', api:'browser-fixture-api', models:[{id:'offline'}], tokensPerSecond:400, tokenSize:{min:4,max:4} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('browser-fixture', { description:'One browser tool call', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('browser', {action:'tabs'}, {id:'tabs-' + Date.now()})], {stopReason:'toolUse'}),
          fauxAssistantMessage('浏览器检查完成。')
        ]);
      }});
    }
  `
  )
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
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).models.some((m) => m.provider === 'browser-fixture')
      )
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'browser-fixture', modelId: 'offline' })
  )
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function askForBrowser(prompt: string): Promise<void> {
  await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({
      type: 'prompt:send',
      text: '/browser-fixture',
      sessionId: sessionId!,
      generation
    })
  })
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill(prompt)
  await draft.press('Enter')
  await expect(page.locator('.assistant-node').last()).toContainText('浏览器检查完成')
}

async function setBrowserPlugin(on: boolean): Promise<void> {
  await setBundledPlugin('浏览器', on)
}

async function setBundledPlugin(name: string, on: boolean): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  const toggle = page.getByRole('switch', { name: `${name} Desktop 面板`, exact: true })
  const row = page.locator('.plugin-row').filter({ has: toggle })
  await expect(row.locator('.plugin-badge').first()).toHaveText('内置')
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
  if (!on) await page.screenshot({ path: join(artifacts, `settings-${name}-off.png`) })
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
}

test('the browser ships as a bundled plugin that gates both its panel and the agent tool', async () => {
  const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(launcher.getByRole('button', { name: '浏览器', exact: true })).toBeVisible()

  await setBrowserPlugin(false)
  await expect(launcher.getByRole('button', { name: '浏览器', exact: true })).toHaveCount(0)
  await askForBrowser('看看浏览器里开着什么')
  const refused = page.locator('.tool-node').last()
  await expect(refused).toHaveClass(/is-error/)
  await expect(refused).toContainText('浏览器插件已关闭')

  await setBrowserPlugin(true)
  await expect(launcher.getByRole('button', { name: '浏览器', exact: true })).toBeVisible()
  await askForBrowser('再看一次')
  await expect(page.locator('.tool-node').last()).not.toHaveClass(/is-error/)
})

test('the terminal ships as a bundled plugin; turning it off hides it and refuses new shells', async () => {
  const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(launcher.getByRole('button', { name: '终端', exact: true })).toBeVisible()

  await setBundledPlugin('终端', false)
  await expect(launcher.getByRole('button', { name: '终端', exact: true })).toHaveCount(0)
  const refused = await page.evaluate(async () => {
    const { project } = await window.pi.getState()
    return window.pi.terminal({ type: 'create', projectPath: project!.path, cols: 80, rows: 24 })
  })
  expect(refused).toEqual({
    type: 'unavailable',
    message: expect.stringContaining('终端插件已关闭')
  })

  await setBundledPlugin('终端', true)
  await expect(launcher.getByRole('button', { name: '终端', exact: true })).toBeVisible()
  const allowed = await page.evaluate(async () => {
    const { project } = await window.pi.getState()
    return window.pi.terminal({ type: 'create', projectPath: project!.path, cols: 80, rows: 24 })
  })
  expect(JSON.stringify(allowed)).not.toContain('终端插件已关闭')
})
