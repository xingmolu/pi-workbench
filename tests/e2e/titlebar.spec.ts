import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'
import { openWorkbenchTool } from './workbench-helpers'

const artifacts = resolve('artifacts/e2e/titlebar')

test('the title bar carries back, forward, the sidebar switch and the workbench tabs', async () => {
  await mkdir(artifacts, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-titlebar-')))
  for (const name of ['home', 'agent', 'data', 'project']) await mkdir(join(root, name))
  await writeFile(join(root, 'project/README.md'), '# Project\n')
  const plugin = join(root, 'agent/desktop-plugins/board')
  await mkdir(plugin, { recursive: true })
  const view = (id: string, title: string, placement?: 'page'): Record<string, unknown> => ({
    id,
    title,
    icon: 'flask',
    entry: 'page.html',
    activation: 'onApp',
    ...(placement ? { placement } : {})
  })
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
          view('board', '看板', 'page'),
          view('notes', '笔记', 'page'),
          view('panel', '看板面板')
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).ready))
      .toBe(true)
    await page.evaluate(
      (cwd) => window.pi.send({ type: 'project:open', cwd }),
      join(root, 'project')
    )
    const sidebar = page.getByRole('complementary', { name: '项目和会话' })
    await expect(sidebar.locator('.sidebar-new-session')).toBeEnabled()

    // The window controls sit in the sidebar's title bar row.
    const head = page.locator('.sidebar-head')
    await expect(head.getByRole('button', { name: '后退' })).toBeDisabled()
    await expect(head.getByRole('button', { name: '前进' })).toBeDisabled()
    await page.screenshot({ path: join(artifacts, 'sidebar.png') })

    // The product menu gathers the app-wide actions.
    await page.getByRole('button', { name: 'Pi Desktop 菜单' }).click()
    for (const item of ['新会话', '添加项目', '搜索所有会话', '设置'])
      await expect(page.getByRole('menuitem', { name: new RegExp(item) })).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'brand-menu.png') })
    await page.keyboard.press('Escape')

    // Back and forward step through the pages visited.
    const rail = page.getByRole('navigation', { name: '活动栏' })
    await rail.getByRole('button', { name: '看板', exact: true }).click()
    await expect(page.getByRole('main', { name: '看板' })).toBeVisible()
    await rail.getByRole('button', { name: '笔记', exact: true }).click()
    const notes = page.getByRole('main', { name: '笔记' })
    await expect(notes).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'page.png') })
    await notes.getByRole('button', { name: '后退' }).click()
    const board = page.getByRole('main', { name: '看板' })
    await expect(board).toBeVisible()
    await expect(board.getByRole('button', { name: '后退' })).toBeDisabled()
    await board.getByRole('button', { name: '前进' }).click()
    await expect(page.getByRole('main', { name: '笔记' })).toBeVisible()
    await page.keyboard.press('Control+BracketLeft')
    await expect(page.getByRole('main', { name: '看板' })).toBeVisible()
    await rail.getByRole('button', { name: '项目和会话' }).click()
    await expect(sidebar).toBeVisible()

    // Folding the sidebar moves the controls into the conversation header.
    await head.getByRole('button', { name: '收起侧栏' }).click()
    await expect(sidebar).toHaveCount(0)
    const conversationHead = page.locator('.conversation-head')
    await expect(conversationHead.getByRole('button', { name: '展开侧栏' })).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'sidebar-folded.png') })
    await conversationHead.getByRole('button', { name: '展开侧栏' }).click()
    await expect(sidebar).toBeVisible()

    // Workbench tabs show the number that selects them.
    await openWorkbenchTool(page, '文件')
    await openWorkbenchTool(page, '看板面板')
    await expect(page.locator('.workbench-tab-shortcut')).toHaveText(['Ctrl+1', 'Ctrl+2'])
    await page.locator('.conversation-head').click()
    await page.keyboard.press('Control+1')
    await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.screenshot({ path: join(artifacts, 'workbench.png') })

    // Maximizing gives the workbench the conversation's room, and restores it.
    const workbenchWidth = (): Promise<number> =>
      page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().width)
    const before = await workbenchWidth()
    await page.getByRole('button', { name: '最大化工作台' }).click()
    await expect(page.locator('.conversation-panel')).toBeHidden()
    await expect.poll(workbenchWidth).toBeGreaterThan(before + 400)
    await page.screenshot({ path: join(artifacts, 'workbench-maximized.png') })
    await page.getByRole('button', { name: '还原工作台' }).click()
    await expect(page.locator('.conversation-panel')).toBeVisible()
    await expect.poll(workbenchWidth).toBeCloseTo(before, 0)
    // The same switch the appearance setting makes.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
      document.documentElement.style.colorScheme = 'dark'
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(artifacts, 'workbench-dark.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
