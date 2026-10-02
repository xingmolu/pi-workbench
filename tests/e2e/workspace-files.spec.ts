import { openWorkbenchTool } from './workbench-helpers'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'

let app: ElectronApplication
let page: Page
let root: string
let projectA: string
let projectB: string

async function release(event: string): Promise<void> {
  await app.evaluate(({ ipcMain }, name) => ipcMain.emit(name), event)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-files-')))
  projectA = join(root, '项目 A')
  projectB = join(root, '项目 B')
  for (const path of [
    'agent',
    'user-data',
    'home',
    '项目 A/中文 空间',
    '项目 A/empty',
    '项目 A/.GIT',
    '项目 B'
  ])
    await mkdir(join(root, path), { recursive: true })
  await writeFile(
    join(projectA, '中文 空间/说明.txt'),
    '<script>alert(1)</script>\n真实项目内容\n' + '长行'.repeat(2000)
  )
  await writeFile(join(projectA, 'binary.bin'), Buffer.from([0, 1, 2]))
  await writeFile(join(projectA, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
  await writeFile(join(projectA, '.hidden'), '隐藏内容')
  await writeFile(join(projectB, 'B-only.txt'), '项目 B 内容')
  await symlink(projectB, join(projectA, 'external'))
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  app = await electron.launch({
    args: [resolve('.')],
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
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), projectA)
  await openWorkbenchTool(page, '文件')
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('real workspace files: tree, safe preview, search, refresh and project isolation', async () => {
  const pane = page.getByRole('region', { name: '项目文件' })
  await expect(pane.getByLabel('搜索文件名')).toBeVisible()
  await pane.getByRole('button', { name: '中文 空间', exact: true }).click()
  await pane.getByRole('button', { name: '说明.txt', exact: true }).click()
  await expect(pane.locator('pre')).toContainText('<script>alert(1)</script>')
  await expect(pane.locator('script')).toHaveCount(0)
  await page.screenshot({ path: 'artifacts/e2e/workspace-files-preview.png' })
  expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await writeFile(join(projectA, '中文 空间/说明.txt'), '刷新后的内容')
  await pane.getByRole('button', { name: '刷新文件' }).click()
  await expect(pane.locator('pre')).toHaveText('刷新后的内容')
  await pane.getByRole('button', { name: '返回文件列表' }).click()
  await expect(pane.getByRole('button', { name: '说明.txt', exact: true })).toBeVisible()
  await expect(pane.getByRole('button', { name: '说明.txt', exact: true })).toBeFocused()
  await pane.getByLabel('搜索文件名').fill('说明')
  await expect(pane.getByRole('button', { name: '中文 空间/说明.txt', exact: true })).toBeVisible()
  await pane.getByRole('button', { name: '中文 空间/说明.txt', exact: true }).click()
  await expect(pane.locator('pre')).toHaveText('刷新后的内容')
  await pane.getByRole('button', { name: '返回文件列表' }).click()
  await expect(pane.getByRole('button', { name: '中文 空间/说明.txt', exact: true })).toBeFocused()
  await pane.getByLabel('搜索文件名').fill('不存在')
  await expect(pane.getByText('没有匹配的文件')).toBeVisible()
  await pane.getByLabel('搜索文件名').fill('')
  await pane.getByLabel('显示隐藏文件').check()
  await expect(pane.getByRole('button', { name: '.hidden', exact: true })).toBeVisible()
  await expect(pane.getByRole('button', { name: /external/ })).toBeDisabled()
  await pane.getByRole('button', { name: 'empty', exact: true }).click()
  await expect(pane.getByText('空目录')).toBeVisible()
  await page.screenshot({ path: 'artifacts/e2e/workspace-files.png' })
  for (const [name, error] of [
    ['binary.bin', '二进制文件无法预览'],
    ['large.txt', '文件超过 1 MiB，无法预览']
  ]) {
    await pane.getByRole('button', { name: name!, exact: true }).click()
    await expect(pane.getByRole('alert')).toContainText(error!)
    await expect(pane.locator('pre')).toHaveCount(0)
    await pane.getByRole('button', { name: '返回文件列表' }).click()
  }
  for (const path of ['../项目 B/B-only.txt', '.GIT/config', 'external/B-only.txt']) {
    expect(
      await page.evaluate(
        async ({ projectPath, path }) => {
          try {
            await window.pi.workspaceFiles({ type: 'read', projectPath, path })
            return false
          } catch {
            return true
          }
        },
        { projectPath: projectA, path }
      )
    ).toBe(true)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 760))
  await page.screenshot({ path: 'artifacts/e2e/workspace-files-960.png' })
  expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), projectB)
  await expect(pane.getByRole('button', { name: 'B-only.txt', exact: true })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'binary.bin', exact: true })).toHaveCount(0)
  await expect(pane.getByLabel('显示隐藏文件')).not.toBeChecked()
})

test('filename-inferred TypeScript preview preserves CRLF and trailing blank lines', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  const source = '\tconst count: number = 42  \r\n\r\n'
  await writeFile(join(projectA, 'example.ts'), source)
  const pane = page.getByRole('region', { name: '项目文件' })
  await pane.getByRole('button', { name: '刷新文件' }).click()
  await pane.getByRole('button', { name: 'example.ts', exact: true }).click()
  const code = pane.locator('.highlighted-code')
  await expect(code).toHaveAttribute('data-highlighted', 'true')
  expect(await code.textContent()).toBe(source)
  expect(await code.locator('span[style]').count()).toBeGreaterThan(3)
  const darkColor = await code.locator('span[style]').first().evaluate(el => getComputedStyle(el).color)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(code).toHaveAttribute('data-highlighted', 'true')
  await expect.poll(() => code.locator('span[style]').first().evaluate(el => getComputedStyle(el).color)).not.toBe(darkColor)
  expect(await code.textContent()).toBe(source)
  await page.screenshot({ path: 'artifacts/e2e/theme-light-file.png' })
  await expect(code.locator('.source-line-number')).toHaveCount(3)
  await expect(code.locator('.source-line-number').last()).toHaveAttribute('data-line', '3')
  await pane.getByRole('checkbox', { name: '自动换行' }).check()
  await expect(pane.locator('pre')).toHaveClass('is-wrapped')
  expect(await code.textContent()).toBe(source)
  const head = await pane.locator('.files-preview-head').boundingBox()
  expect(head!.height).toBeLessThan(100)
  await page.screenshot({ path: 'artifacts/e2e/reading-files-polish.png' })
  await pane.getByRole('button', { name: '返回文件列表' }).click()
  const longName = 'very-long-filename-for-narrow-workbench-reading-and-ellipsis.ts'
  const longSource = `const longValue = '${'x'.repeat(400)}'\n`.repeat(200)
  await writeFile(join(projectA, longName), longSource)
  await pane.getByRole('button', { name: '刷新文件' }).click()
  await pane.getByRole('button', { name: longName, exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 760))
  await expect(pane.locator('pre')).toContainText('longValue')
  expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect(await pane.locator('.files-preview-head').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'artifacts/e2e/reading-files-narrow.png' })
})

test('isolated IPC fixture: stale reads and searches cannot cross selections or project A→B→A', async () => {
  // Only this test replaces the filesystem boundary, to release old responses deterministically.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:workspace-files')
    ipcMain.handle('pi:workspace-files', async (_event, command) => {
      const entries = ['slow.txt', 'fast.txt', 'denied.txt'].map((name) => ({
        name,
        path: name,
        kind: 'file'
      }))
      if (command.type === 'list') return { type: 'list', entries, truncated: false }
      if (command.type === 'search') {
        if (command.query === 'limited') return { type: 'search', entries, truncated: true }
        if (command.query === 'old') {
          return new Promise((resolve) =>
            ipcMain.once('files:release-search', () =>
              resolve({
                type: 'search',
                entries: [{ name: 'old-result.txt', path: 'old-result.txt', kind: 'file' }],
                truncated: false
              })
            )
          )
        }
        return { type: 'search', entries: [], truncated: false }
      }
      if (command.path === 'denied.txt') throw new Error('没有权限访问此文件')
      if (command.path === 'slow.txt') {
        return new Promise((resolve) =>
          ipcMain.once('files:release-read', () =>
            resolve({ type: 'read', path: 'slow.txt', text: 'STALE CONTENT', size: 13 })
          )
        )
      }
      return { type: 'read', path: 'fast.txt', text: 'CURRENT CONTENT', size: 15 }
    })
  })
  const pane = page.getByRole('region', { name: '项目文件' })
  await pane.getByRole('button', { name: '刷新文件' }).click()
  await pane.getByRole('button', { name: 'slow.txt', exact: true }).click()
  await expect(pane.getByText('正在读取文件…')).toBeVisible()
  await expect
    .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount('files:release-read')))
    .toBe(1)
  await pane.getByRole('button', { name: '返回文件列表' }).click()
  await pane.getByRole('button', { name: 'fast.txt', exact: true }).click()
  await expect(pane.locator('pre')).toHaveText('CURRENT CONTENT')
  // Clipboard boundary is isolated as well: never overwrite the user's clipboard in this test.
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} }
    })
  )
  await pane.getByRole('button', { name: '复制相对路径' }).click()
  await expect(pane.getByRole('status')).toHaveText('已复制相对路径')
  await pane.getByRole('button', { name: '复制内容', exact: true }).click()
  await expect(pane.getByRole('status')).toHaveText('已复制内容')
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied')
        }
      }
    })
  )
  await pane.getByRole('button', { name: '复制内容', exact: true }).click()
  await expect(pane.getByRole('status')).toHaveText('复制失败，请检查剪贴板权限后重试')
  await release('files:release-read')
  await expect(pane.locator('pre')).toHaveText('CURRENT CONTENT')
  await pane.getByRole('button', { name: '返回文件列表' }).click()
  await pane.getByLabel('搜索文件名').fill('old')
  await expect
    .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount('files:release-search')))
    .toBe(1)
  await pane.getByLabel('搜索文件名').fill('new')
  await expect(pane.getByText('没有匹配的文件')).toBeVisible()
  await release('files:release-search')
  await expect(pane.getByRole('button', { name: 'old-result.txt' })).toHaveCount(0)
  await pane.getByLabel('搜索文件名').fill('limited')
  await expect(pane.getByRole('status')).toContainText('仅显示部分结果')
  await pane.getByLabel('搜索文件名').fill('')
  await pane.getByRole('button', { name: 'denied.txt', exact: true }).click()
  await expect(pane.getByRole('alert')).toContainText('没有权限访问此文件')
  await expect(pane.locator('pre')).toHaveCount(0)
  await expect(pane.getByRole('button', { name: '复制内容', exact: true })).toBeDisabled()
  await pane.getByRole('button', { name: '返回文件列表' }).click()
  await pane.getByRole('button', { name: 'slow.txt', exact: true }).click()
  await expect
    .poll(() => app.evaluate(({ ipcMain }) => ipcMain.listenerCount('files:release-read')))
    .toBe(1)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), projectB)
  await expect(pane.locator('pre')).toHaveCount(0)
  await expect(pane.getByRole('button', { name: 'fast.txt', exact: true })).toBeVisible()
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), projectA)
  await pane.getByRole('button', { name: 'fast.txt', exact: true }).click()
  await expect(pane.locator('pre')).toHaveText('CURRENT CONTENT')
  await release('files:release-read')
  await expect(pane.locator('pre')).toHaveText('CURRENT CONTENT')
})
