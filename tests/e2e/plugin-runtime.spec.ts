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

const artifacts = resolve('artifacts/e2e/plugin-runtime')
let app: ElectronApplication, page: Page, root: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-plugin-runtime-')))
  const agent = join(root, 'agent')
  const plugin = join(agent, 'desktop-plugins', 'hello')
  await Promise.all([
    mkdir(join(root, 'project')),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(plugin, 'views'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  await writeFile(
    join(plugin, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.hello',
      version: '1.0.0',
      name: 'Hello',
      description: 'Runtime fixture',
      engines: { piDesktop: '^0.1.0' },
      main: 'main.js',
      permissions: ['ui.view', 'notify', 'net.websocket'],
      contributes: {
        views: [
          {
            id: 'panel',
            title: { en: 'Hello', 'zh-CN': '你好面板' },
            icon: 'flask',
            entry: 'views/panel.html',
            activation: 'onApp'
          }
        ],
        commands: [
          { id: 'greet', title: { en: 'Say hello', 'zh-CN': '打个招呼' }, keywords: ['hello'] },
          { id: 'store', title: '写入存储' },
          { id: 'crash', title: '让插件崩溃' }
        ]
      }
    })
  )
  await writeFile(
    join(plugin, 'views', 'panel.html'),
    '<!doctype html><title>Hello</title><p>hello view</p>'
  )
  await writeFile(
    join(plugin, 'main.js'),
    `
    const env = Object.keys(process.env).sort().join(',')
    module.exports = {
      async onLoad() {
        await pi.commands.register({ id: 'greet', run: async () => {
          await pi.ui.showToast('你好，来自插件进程')
          await pi.ui.openView('panel')
        } })
        await pi.commands.register({ id: 'store', run: async () => {
          try { await pi.storage.set('k', 1) }
          catch (error) { await pi.ui.showToast('被拒绝：' + error.code) }
        } })
        await pi.commands.register({ id: 'crash', run: () => { setTimeout(() => process.exit(3), 10) } })
        await pi.ui.showToast('已加载，环境变量：' + (env.includes('PI_PLUGIN_ID') && !env.includes('PI_DESKTOP_E2E') ? '受限' : '未受限'))
      }
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
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function palette(): Promise<void> {
  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await expect(page.getByRole('dialog', { name: '搜索与快捷操作' })).toBeVisible()
}

test('a plugin that runs code needs a grant, then serves commands through the gateway and is contained when it crashes', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  const row = page.locator('.plugin-row').filter({ hasText: 'Hello' })
  const toggle = row.getByRole('switch', { name: 'Hello Desktop 面板' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  const review = row.getByRole('group', { name: '授权 Hello' })
  await expect(review).toContainText('独立进程中运行代码')
  await expect(review.locator('li.is-low')).toHaveCount(2)
  await expect(review.locator('li.is-unsupported')).toContainText('net.websocket')
  await page.screenshot({ path: join(artifacts, 'grant.png'), animations: 'disabled' })
  await review.getByRole('button', { name: '授权并启用' }).click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(row).toContainText('进程：运行中')
  await expect(page.locator('.navigation-toast')).toContainText('Hello：已加载，环境变量：受限')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()

  await palette()
  await page.getByRole('combobox', { name: '搜索所有会话标题' }).fill('hello')
  const greet = page.getByRole('option', { name: /打个招呼/ })
  await expect(greet).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'palette.png'), animations: 'disabled' })
  await greet.click()
  await expect(page.locator('.navigation-toast')).toContainText('Hello：你好，来自插件进程')
  await expect(page.getByRole('tab', { name: /你好面板/ })).toBeVisible()

  await palette()
  await page.getByRole('option', { name: /写入存储/ }).click()
  await expect(page.locator('.navigation-toast')).toContainText('被拒绝：PERMISSION_DENIED')

  await palette()
  await page.getByRole('option', { name: /让插件崩溃/ }).click()
  await expect(page.locator('.navigation-toast')).toContainText('意外退出')
  await palette()
  await expect(page.getByRole('option', { name: /打个招呼/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const audit = await readFile(join(root, 'agent', 'pi-desktop', 'plugin-audit.jsonl'), 'utf8')
  const lines = audit
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    lines.some((line) => line.method === 'storage.set' && line.outcome === 'PERMISSION_DENIED')
  ).toBe(true)
  expect(audit).not.toContain('"k"')
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toBeVisible()
})
