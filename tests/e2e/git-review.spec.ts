import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication
let page: Page
let root: string
let project: string
function git(...args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8'
  })
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-e2e-git-')))
  project = join(root, '项目 A')
  for (const p of ['home', 'agent', 'user-data', '项目 A', '项目 B']) await mkdir(join(root, p))
  git('init', '-b', 'baseline')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(project, 'partial.txt'), 'BASE\n')
  await writeFile(join(project, 'deleted.txt'), 'DELETED CONTENT\n')
  git('add', '.')
  git('commit', '-m', 'base')
  git('checkout', '-b', 'feature')
  await writeFile(join(project, 'committed.txt'), 'COMMITTED BRANCH\n')
  git('add', '.')
  git('commit', '-m', 'feature')
  await writeFile(join(project, 'partial.txt'), 'STAGED\n')
  git('add', 'partial.txt')
  await writeFile(join(project, 'partial.txt'), 'WORKTREE\n')
  await unlink(join(project, 'deleted.txt'))
  await writeFile(join(project, '中文 <note>.txt'), '<script>UNTRACKED</script>\n')
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  app = await electron.launch({
    args: [resolve('.')],
    env: {
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
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.getByRole('button', { name: '审查', exact: true }).click()
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('real Git: partial stage, deleted, branch and untracked preview', async () => {
  const pane = page.getByRole('region', { name: 'Git 审阅' })
  await expect(pane.getByRole('button', { name: '未暂存', exact: true })).toBeVisible()
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('WORKTREE')
  await expect(pane.locator('.git-patch')).toContainText('STAGED')
  await expect(pane.getByRole('img', { name: '新增行' })).toHaveText('+')
  await expect(pane.getByRole('img', { name: '删除行' })).toHaveText('−')
  await pane.getByRole('button', { name: '已暂存', exact: true }).click()
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('BASE')
  await expect(pane.locator('.git-patch')).not.toContainText('WORKTREE')
  await pane.getByRole('button', { name: '分支', exact: true }).click()
  await expect(pane.getByLabel('比较基准')).toHaveValue('')
  await expect(pane.getByRole('alert')).toContainText('基准')
  await pane.getByLabel('比较基准').selectOption('refs/heads/baseline')
  await pane.getByRole('button', { name: 'committed.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('COMMITTED BRANCH')
  await pane.getByRole('button', { name: '未暂存', exact: true }).click()
  await pane.getByRole('button', { name: 'deleted.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('DELETED CONTENT')
  await pane.getByRole('button', { name: '中文 <note>.txt', exact: true }).click()
  await expect(pane.locator('pre')).toHaveText('<script>UNTRACKED</script>\n')
  await expect(pane.locator('script')).toHaveCount(0)
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('WORKTREE')
  await page.screenshot({ path: 'artifacts/e2e/git-review.png' })
  await pane.getByRole('button', { name: '分栏', exact: true }).click()
  await expect(pane.locator('.diff-split')).toBeVisible()
  await pane.getByRole('button', { name: '统一', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 760))
  await page.screenshot({ path: 'artifacts/e2e/git-review-960.png' })
  expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('real Git: distinct local/remote ref labels, keyboard selection, host exit and reconnect', async () => {
  const pane = page.getByRole('region', { name: 'Git 审阅' })
  git('branch', 'origin/shared', 'baseline')
  git('update-ref', 'refs/remotes/origin/shared', 'baseline')
  await pane.getByRole('button', { name: '刷新差异' }).click()
  await pane.getByRole('button', { name: '分支', exact: true }).click()
  await expect(pane.getByRole('option', { name: '本地 · origin/shared', exact: true })).toHaveCount(
    1
  )
  await expect(
    pane.getByRole('option', { name: '远端引用 · origin/shared', exact: true })
  ).toHaveCount(1)
  await pane.getByLabel('比较基准').selectOption('refs/remotes/origin/shared')
  const file = pane.getByRole('button', { name: 'committed.txt', exact: true })
  await file.focus()
  await page.keyboard.press('Enter')
  await expect(file).toBeFocused()
  await expect(pane.locator('.git-patch')).toContainText('COMMITTED BRANCH')
  const pid = await app.evaluate(
    ({ app }) => app.getAppMetrics().find((metric) => metric.name === 'Pi Agent Host')?.pid
  )
  expect(pid).toBeTruthy()
  await app.evaluate(({}, pid) => process.kill(pid!, 'SIGKILL'), pid)
  await expect(pane.getByRole('status')).toContainText('引擎已断开')
  await expect(pane.locator('.git-patch')).toHaveCount(0)
  await expect(pane.getByRole('button', { name: '刷新差异' })).toHaveCount(0)
  await page.getByRole('button', { name: '重新连接引擎' }).click()
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('WORKTREE')
})

test('real Git: refresh, clean, non-repository, unborn and filter refusal', async () => {
  const pane = page.getByRole('region', { name: 'Git 审阅' })
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await writeFile(join(project, 'partial.txt'), 'REFRESHED\n')
  await pane.getByRole('button', { name: '刷新差异' }).click()
  await expect(pane.locator('.git-patch')).toHaveCount(0)
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('REFRESHED')
  git('add', '.')
  git('commit', '-m', 'clean fixture')
  await pane.getByRole('button', { name: '刷新差异' }).click()
  await expect(pane.getByText('此范围没有改动')).toBeVisible()
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, '项目 B'))
  await expect(pane.getByRole('alert')).toContainText('Git')
  await expect(pane.locator('.git-patch')).toHaveCount(0)
  project = join(root, '项目 B')
  git('init', '-b', 'unborn')
  await writeFile(join(project, 'first.txt'), 'UNBORN FIRST\n')
  git('add', '.')
  await pane.getByRole('button', { name: '已暂存', exact: true }).click()
  await pane.getByRole('button', { name: 'first.txt', exact: true }).click()
  await expect(pane.locator('.git-patch')).toContainText('UNBORN FIRST')
  git('config', 'filter.denied.clean', 'echo must-not-run')
  await pane.getByRole('button', { name: '刷新差异' }).click()
  await expect(pane.getByRole('alert')).toContainText('过滤器')
  await expect(pane.locator('.git-patch')).toHaveCount(0)
})

test('real Git: complete large/raw-byte fallback and safe untracked failures', async () => {
  const pane = page.getByRole('region', { name: 'Git 审阅' })
  await writeFile(join(project, 'large.txt'), 'old\n')
  await writeFile(join(project, 'bytes.txt'), 'old\n')
  git('add', 'large.txt', 'bytes.txt')
  git('commit', '-m', 'fallback fixtures')
  const large =
    Array.from({ length: 2200 }, (_, i) => `line-${i}`).join('\n') +
    '\n<script>LAST LINE</script>\n'
  await writeFile(join(project, 'large.txt'), large)
  await writeFile(join(project, 'bytes.txt'), Buffer.from([0x61, 0xff, 0x0a]))
  await writeFile(join(project, 'binary.bin'), Buffer.from([0, 1, 2]))
  await writeFile(join(project, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1))
  await writeFile(join(project, ':unsupported.txt'), 'not previewable')
  await pane.getByRole('button', { name: '刷新差异' }).click()
  await pane.getByRole('button', { name: 'large.txt', exact: true }).click()
  await expect(pane.getByLabel('原始差异')).toContainText('<script>LAST LINE</script>')
  await expect(pane.getByText('原始差异 · 差异较大，以完整原始文本显示')).toBeVisible()
  await expect(pane.locator('.diff')).toHaveCount(0)
  await expect(pane.locator('script')).toHaveCount(0)
  await pane.getByRole('button', { name: 'bytes.txt', exact: true }).click()
  await expect(pane.getByLabel('原始差异')).toContainText('\\xff')
  await expect(pane.locator('.diff')).toHaveCount(0)
  for (const name of ['binary.bin', 'huge.txt', ':unsupported.txt']) {
    await pane.getByRole('button', { name, exact: true }).click()
    await expect(pane.getByRole('alert')).toBeVisible()
    await expect(pane.locator('pre')).toHaveCount(0)
  }
  await pane.getByRole('button', { name: 'partial.txt', exact: true }).click()
  await expect(pane.locator('.diff')).toBeVisible()
})

test('isolated transport fixture: late patches, preview, mode/project changes and unknown errors', async () => {
  // This test deliberately replaces IPC responses; it does not claim real Git behavior.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:git-review')
    ipcMain.handle('pi:git-review', async (_event, command) => {
      if (command.type === 'refs') return { type: 'refs', refs: [] }
      if (command.type === 'list')
        return {
          type: 'list',
          reviewId: 'fixture',
          view: command.view,
          entries: [
            ...['slow', 'fast', 'denied', 'malformed', 'type'].map((path) => ({
              entryId: path,
              path,
              kind: 'tracked',
              status: 'M'
            })),
            {
              entryId: 'preview',
              path: 'preview',
              kind: 'untracked',
              status: '?',
              previewPath: 'preview'
            }
          ]
        }
      if (command.entryId === 'denied') throw new Error('fixture local failure')
      const patch = {
        type: 'patch',
        reviewId: 'fixture',
        entryId: command.entryId,
        kind: 'text',
        text: 'unparseable <script>SAFE</script>',
        message: ''
      }
      if (command.entryId === 'slow')
        return new Promise((resolve) =>
          ipcMain.once('git:release', () => resolve({ ...patch, text: 'LATE OLD PATCH' }))
        )
      if (command.entryId === 'type')
        return { ...patch, kind: 'type-only', text: 'old mode 100644\nnew mode 100755\n' }
      return { ...patch, text: command.entryId === 'fast' ? 'CURRENT PATCH' : patch.text }
    })
    ipcMain.removeHandler('pi:workspace-files')
    ipcMain.handle(
      'pi:workspace-files',
      () =>
        new Promise((resolve) =>
          ipcMain.once('git:preview-release', () =>
            resolve({ type: 'read', path: 'preview', text: 'LATE PREVIEW', size: 12 })
          )
        )
    )
  })
  const pane = page.getByRole('region', { name: 'Git 审阅' })
  const release = async (event: string): Promise<void> => {
    await app.evaluate(({ ipcMain }, name) => ipcMain.emit(name), event)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  }
  const pending = async (name: string): Promise<void> => {
    await expect
      .poll(() => app.evaluate(({ ipcMain }, event) => ipcMain.listenerCount(event), name))
      .toBe(1)
  }
  await pane.getByRole('button', { name: '刷新差异' }).click()
  await pane.getByRole('button', { name: 'slow', exact: true }).click()
  await pending('git:release')
  await pane.getByRole('button', { name: 'fast', exact: true }).click()
  await expect(pane.locator('pre')).toHaveText('CURRENT PATCH')
  await release('git:release')
  await expect(pane.locator('pre')).toHaveText('CURRENT PATCH')
  await pane.getByRole('button', { name: 'preview', exact: true }).click()
  await pending('git:preview-release')
  await expect(pane.locator('pre')).toHaveCount(0)
  await pane.getByRole('button', { name: 'denied', exact: true }).click()
  await expect(pane.getByRole('alert')).toContainText('fixture local failure')
  await release('git:preview-release')
  await expect(pane.locator('pre')).toHaveCount(0)
  await pane.getByRole('button', { name: 'malformed', exact: true }).click()
  await expect(pane.getByLabel('原始差异')).toHaveText('unparseable <script>SAFE</script>')
  await expect(pane.locator('script')).toHaveCount(0)
  await pane.getByRole('button', { name: 'type', exact: true }).click()
  await expect(pane.getByLabel('原始差异')).toContainText('new mode 100755')
  await pane.getByRole('button', { name: 'slow', exact: true }).click()
  await pending('git:release')
  await pane.getByRole('button', { name: '已暂存', exact: true }).click()
  await release('git:release')
  await expect(pane.locator('pre')).toHaveCount(0)
  await pane.getByRole('button', { name: 'slow', exact: true }).click()
  await pending('git:release')
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, '项目 B'))
  await expect(pane.locator('pre')).toHaveCount(0)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await pane.getByRole('button', { name: 'fast', exact: true }).click()
  await release('git:release')
  await expect(pane.locator('pre')).toHaveText('CURRENT PATCH')
})
