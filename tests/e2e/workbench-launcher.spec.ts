import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'

const artifacts = resolve('artifacts/e2e/workbench-launcher')

test('the workbench start page lists tools with shortcuts and recent sites', async () => {
  await mkdir(artifacts, { recursive: true })
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Shop preview</title><h1>Shop</h1>')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-launcher-')))
  for (const name of ['home', 'agent', 'data', 'project']) await mkdir(join(root, name))
  await writeFile(join(root, 'project/README.md'), '# Project\n')
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
    await page.getByRole('button', { name: '展开工作台', exact: true }).click()
    const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
    const tools = launcher.getByRole('region', { name: '工具' })
    await expect(tools.getByRole('button', { name: '终端', exact: true })).toContainText('Ctrl+J')
    await expect(tools.getByRole('button', { name: '文件', exact: true })).toContainText('Ctrl+P')
    // Nothing visited yet, so nothing to recommend.
    await expect(launcher.getByRole('region', { name: '推荐' })).toHaveCount(0)
    await page.screenshot({ path: join(artifacts, 'tools.png') })

    // A page visited in the browser comes back as a recommendation.
    await tools.getByRole('button', { name: '浏览器', exact: true }).click()
    const address = page.getByPlaceholder('搜索或输入网址')
    await address.fill(url)
    await address.press('Enter')
    const tab = page.locator('.workbench-tab[data-tool="浏览器"]')
    await expect(tab.getByRole('tab')).toHaveAccessibleName('Shop preview')
    await page.getByRole('button', { name: '关闭Shop preview标签' }).click()
    const sites = launcher.getByRole('region', { name: '推荐' })
    await expect(sites.getByRole('button', { name: /^Shop preview/ })).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'recent.png') })

    // Choosing it opens the site in a single browser tab.
    await sites.getByRole('button', { name: /^Shop preview/ }).click()
    await expect(tab).toHaveCount(1)
    await expect(tab.getByRole('tab')).toHaveAccessibleName('Shop preview')
    await expect(address).toHaveValue(url)

    // ⌘P / Ctrl+P opens the file search.
    await page.locator('.conversation-head').click()
    await page.keyboard.press('Control+P')
    await expect(page.locator('.workbench-tab[data-tool="文件"]')).toHaveAttribute(
      'data-active',
      'true'
    )

    // A recommendation can be removed.
    await page.getByRole('button', { name: '关闭Shop preview标签' }).click()
    await page.getByRole('button', { name: '关闭文件标签' }).click()
    await sites.getByRole('button', { name: '从推荐中移除 Shop preview' }).click()
    await expect(launcher.getByRole('region', { name: '推荐' })).toHaveCount(0)
  } finally {
    await app.close()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
