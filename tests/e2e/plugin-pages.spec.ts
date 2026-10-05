import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'

test('a plugin page opens from the activity rail over sessions, conversation and workbench', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-plugin-pages-')))
  for (const name of ['home', 'agent', 'data', 'project']) await mkdir(join(root, name))
  const plugin = join(root, 'agent/desktop-plugins/board')
  await mkdir(plugin, { recursive: true })
  await writeFile(
    join(plugin, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example.board',
      version: '1.0.0',
      name: 'Board',
      engines: { piDesktop: '^0.1.0' },
      contributes: {
        views: [
          {
            id: 'page',
            title: '看板',
            icon: 'flask',
            entry: 'page.html',
            activation: 'onApp',
            placement: 'page'
          },
          {
            id: 'panel',
            title: '看板面板',
            icon: 'plugin',
            entry: 'page.html',
            activation: 'onApp'
          }
        ]
      }
    })
  )
  await writeFile(join(plugin, 'page.html'), '<!doctype html><title>Board</title><h1>Board</h1>')
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
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).ready))
      .toBe(true)
    await page.evaluate(
      (cwd) => window.pi.send({ type: 'project:open', cwd }),
      join(root, 'project')
    )
    const rail = page.getByRole('navigation', { name: '活动栏' })
    const entry = rail.getByRole('button', { name: '看板', exact: true })
    await expect(entry).toBeVisible()

    // Only the panel view is offered in the workbench; the page lives in the rail.
    await page.getByRole('button', { name: '展开工作台' }).click()
    const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
    await expect(launcher.getByRole('button', { name: '看板面板' })).toBeVisible()
    await expect(launcher.getByRole('button', { name: '看板', exact: true })).toHaveCount(0)

    await entry.click()
    await expect(entry).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('main', { name: '看板' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: '项目和会话' })).toBeHidden()
    await expect(page.locator('.workbench-toggle')).toHaveCount(0)
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.pi.workbench({ type: 'state:get' }))
        return state.state.contributions.find(({ viewId }) => viewId === 'example.board.page')
          ?.placement
      })
      .toBe('page')

    // The page itself is the plugin's sandboxed document.
    await expect
      .poll(() =>
        app.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((contents) => contents.getTitle() === 'Board')
        )
      )
      .toBe(true)

    // The sessions entry returns to the conversation, as does the page's close button.
    await rail.getByRole('button', { name: '项目和会话' }).click()
    await expect(page.getByRole('main', { name: '看板' })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: '项目和会话' })).toBeVisible()
    await entry.click()
    await page.getByRole('button', { name: '关闭 看板' }).click()
    await expect(page.getByRole('main', { name: '看板' })).toHaveCount(0)
    await expect(entry).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
