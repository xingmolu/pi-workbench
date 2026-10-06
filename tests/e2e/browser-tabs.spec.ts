import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'
import { openWorkbenchTool } from './workbench-helpers'

const artifacts = resolve('artifacts/e2e/browser-tabs')

test('browser pages are workbench tabs with one toolbar under them', async () => {
  await mkdir(artifacts, { recursive: true })
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(
      `<!doctype html><title>${request.url === '/docs' ? 'Docs' : 'Home'}</title><h1>${request.url}</h1>`
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-browser-tabs-')))
  for (const name of ['home', 'agent', 'data', 'project']) await mkdir(join(root, name))
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).ready))
      .toBe(true)
    await page.evaluate(
      (cwd) => window.pi.send({ type: 'project:open', cwd }),
      join(root, 'project')
    )
    await openWorkbenchTool(page, '浏览器')
    const tabs = page.locator('.workbench-tab[data-tool="浏览器"]')
    await expect(tabs).toHaveCount(1)
    await expect(tabs.getByRole('tab')).toHaveAccessibleName('新标签页')
    // No second row of tabs, and no standing notice while nobody else drives the page.
    await expect(page.locator('.browser-tabs')).toHaveCount(0)
    await expect(page.locator('.browser-control')).toHaveCount(0)

    const address = page.getByPlaceholder('搜索或输入网址')
    await address.fill(`${origin}/home`)
    await address.press('Enter')
    await expect(tabs.getByRole('tab')).toHaveAccessibleName('Home')

    // Asking for the browser again opens another page as another tab.
    await page.getByRole('button', { name: '打开工具', exact: true }).click()
    await page.getByRole('menuitem', { name: '浏览器', exact: true }).click()
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveAttribute('data-active', 'true')
    await address.fill(`${origin}/docs`)
    await address.press('Enter')
    await expect(tabs.nth(1).getByRole('tab')).toHaveAccessibleName('Docs')
    await expect(page.locator('.workbench-tab-shortcut')).toHaveText(['Ctrl+1', 'Ctrl+2'])
    await page.screenshot({ path: join(artifacts, 'two-pages.png') })

    // Tabs select pages, by click or by number.
    await tabs.nth(0).getByRole('tab').click()
    await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true')
    await expect(address).toHaveValue(`${origin}/home`)
    await page.locator('.conversation-head').click()
    await page.keyboard.press('Control+2')
    await expect(tabs.nth(1)).toHaveAttribute('data-active', 'true')
    await expect(address).toHaveValue(`${origin}/docs`)

    // The menu holds the page actions and the note about the browser's profile.
    await page.getByRole('button', { name: '浏览器更多操作' }).click()
    await expect(page.getByRole('menuitem', { name: '复制链接' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: '在系统浏览器中打开' })).toBeEnabled()
    await expect(page.getByText('独立浏览器资料 · 网页内容不受信任')).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'menu.png') })
    await page.keyboard.press('Escape')

    // Closing a page closes its tab; closing the last one closes the browser.
    await page.getByRole('button', { name: '关闭Docs标签' }).click()
    await expect(tabs).toHaveCount(1)
    await expect(tabs.getByRole('tab')).toHaveAccessibleName('Home')
    await page.getByRole('button', { name: '关闭Home标签' }).click()
    await expect(tabs).toHaveCount(0)
  } finally {
    await app.close()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
