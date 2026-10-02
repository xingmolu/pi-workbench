import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'

let app: ElectronApplication, page: Page, root: string
const artifacts = resolve('artifacts/e2e/english')

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
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
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      ...env
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-english-e2e-')))
  for (const name of ['home', 'agent', 'user-data', 'project'])
    await mkdir(join(root, name), { recursive: true })
  await mkdir(artifacts, { recursive: true })
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('the interface, engine messages and plugin pages follow an English locale', async () => {
  await launch({ PI_DESKTOP_E2E_LOCALE: 'en' })
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(await page.evaluate(() => window.pi.locale)).toBe('en')

  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  const connect = page.getByRole('region', { name: 'Connect a model' })
  await expect(connect).toBeVisible()
  await expect(connect.getByRole('button')).toHaveText([
    /ChatGPT account/,
    /API Key/,
    /Claude account.*downloaded the first time/
  ])
  await expect(page.locator('.composer-lock')).toContainText('Connect a model account first')
  // Text produced by the Pi engine host, not the window, is English too.
  await expect(page.getByRole('textbox', { name: 'Task input' })).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'home.png') })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'Engines & accounts', level: 2 })).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'engines.png') })
  await dialog.getByRole('button', { name: 'General', exact: true }).click()
  await expect(dialog.getByLabel('Interface language')).toHaveValue('system')
  await page.screenshot({ path: join(artifacts, 'settings.png') })

  // No Chinese is left in what the window shows, except the language picker's own name for it.
  const shown = await page.evaluate(() => document.body.innerText)
  expect(shown.match(/[\u4e00-\u9fff]+/g) ?? []).toEqual(['中文'])
})

test('choosing a language is saved and offers a restart', async () => {
  await launch()
  expect(await page.evaluate(() => window.pi.locale)).toBe('zh-CN')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '常规', exact: true }).click()
  await page.getByLabel('界面语言').selectOption('en')
  await expect(page.getByRole('button', { name: '立即重启' })).toBeVisible()
  await expect(page.getByText('重启 Pi Desktop 后生效。')).toBeVisible()
  await expect
    .poll(async () => {
      const stored = JSON.parse(
        await readFile(join(root, 'user-data', 'pi-desktop-preferences.json'), 'utf8')
      )
      return stored.desktopSettings?.language
    })
    .toBe('en')

  // A saved choice wins over the end-to-end default on the next start.
  await app.close()
  await launch()
  expect(await page.evaluate(() => window.pi.locale)).toBe('en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})
