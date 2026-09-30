import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const artifacts = resolve('artifacts/e2e/themes')
let app: ElectronApplication, page: Page, root: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-themes-')))
  const plugin = join(root, 'agent', 'desktop-plugins', 'dusk')
  await Promise.all([
    mkdir(join(root, 'project')),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(plugin, 'themes'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  await writeFile(
    join(plugin, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.dusk',
      version: '1.0.0',
      name: 'Dusk',
      engines: { piDesktop: '^0.1.0' },
      permissions: ['ui.theme'],
      contributes: {
        themes: [
          {
            id: 'dusk',
            label: { en: 'Dusk', 'zh-CN': '黄昏' },
            path: 'themes/dusk.css',
            base: 'dark'
          }
        ]
      }
    })
  )
  await writeFile(
    join(plugin, 'themes', 'dusk.css'),
    `:root {
      --canvas: #16131c;
      --raised: #1b1722;
      --accent: #e0a458;
      --accent-soft: #3a2d1e;
      --accent-text: #f2c58c;
      --line: url(https://example.com/x.png);
    }
    body { display: none; }`
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
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
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

const token = (name: string): Promise<string> =>
  page.evaluate(
    (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name
  )

const themeCard = (name: string): ReturnType<Page['getByRole']> =>
  page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name, exact: true })

test('accent colors and plugin themes restyle the app and fall back when the plugin is off', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await themeCard('浅色').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page
    .getByRole('radiogroup', { name: '强调色' })
    .getByRole('radio', { name: '紫色' })
    .click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet')
  await expect.poll(() => token('--accent')).toBe('#6b4fd4')
  await page.screenshot({ path: join(artifacts, 'accent-light.png'), animations: 'disabled' })

  // A theme appears only once its plugin is enabled with the ui.theme grant.
  await expect(themeCard('黄昏')).toHaveCount(0)
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  const row = page.locator('.plugin-row').filter({ hasText: 'Dusk' })
  await expect(row.locator('.plugin-diagnostics')).toContainText('1 条声明')
  await row.getByRole('switch', { name: 'Dusk Desktop 面板' }).click()
  await expect(row.getByRole('group', { name: '授权 Dusk' })).toContainText('ui.theme')
  await row.getByRole('button', { name: '授权并启用' }).click()

  await page.getByRole('button', { name: '外观', exact: true }).click()
  await expect(themeCard('黄昏')).toContainText('来自 Dusk')
  await themeCard('黄昏').click()
  await expect(page.locator('html')).toHaveAttribute('data-plugin-theme', 'acme.dusk/dusk')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => token('--canvas')).toBe('#16131c')
  expect(await token('--accent')).toBe('#e0a458')
  // Unsafe values never reach the page.
  expect(await token('--line')).not.toContain('url')
  await expect(page.locator('body')).toBeVisible()
  await expect(
    page.getByRole('radiogroup', { name: '强调色' }).getByRole('radio').first()
  ).toBeDisabled()
  await page.screenshot({ path: join(artifacts, 'plugin-theme.png'), animations: 'disabled' })

  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  await row.getByRole('switch', { name: 'Dusk Desktop 面板' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-plugin-theme', /.+/)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => token('--canvas')).toBe('#181818')
  expect(await token('--accent')).toBe('#8a72e8')
})
