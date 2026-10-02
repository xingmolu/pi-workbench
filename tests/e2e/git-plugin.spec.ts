import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { systemGit } from '../../src/main/system-git'
import { displayEnv } from './display-env'

const artifacts = resolve('artifacts/e2e/git-plugin')
const GIT = systemGit()
let app: ElectronApplication, page: Page, root: string, project: string, remote: string

const git = (...args: string[]): string =>
  execFileSync(GIT.path, args, {
    cwd: project,
    env: { ...GIT.env, HOME: join(root, 'home') }
  })
    .toString()
    .trim()

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-git-plugin-')))
  project = join(root, 'shop')
  remote = join(root, 'remote.git')
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'agent')),
    mkdir(join(root, 'user-data')),
    mkdir(artifacts, { recursive: true })
  ])
  execFileSync(GIT.path, ['init', '-q', '--bare', '-b', 'main', remote])
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@example.com')
  await writeFile(join(project, 'src', 'cart.ts'), 'export const total = 1\n')
  await writeFile(join(project, 'readme.md'), '# shop\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'main')

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
      ...displayEnv(),
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

const launcher = (): ReturnType<Page['getByRole']> =>
  page.getByRole('navigation', { name: '打开工作台工具' }).getByRole('button', { name: 'Git' })

/** Runs a script inside the Git panel's sandboxed page. */
function panel<T>(script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, source) =>
      webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith('/views/changes.html'))
        ?.executeJavaScript(source),
    script
  ) as Promise<T>
}

async function capture(name: string): Promise<void> {
  const png = await app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().endsWith('/views/changes.html'))
    return contents ? (await contents.capturePage()).toPNG().toString('base64') : null
  })
  if (png) await writeFile(join(artifacts, name), Buffer.from(png, 'base64'))
}

const rows = (list: 'staged' | 'changes'): Promise<string[] | undefined> =>
  panel(`[...document.querySelectorAll('#${list} .file')].map((row) => row.dataset.path)`)

const click = (label: string): Promise<void> =>
  panel(`document.querySelector('[aria-label="${label}"]')?.click()`)

test('the bundled Git plugin takes changes from the working tree to the remote', async () => {
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await launcher().click()
  await expect(page.getByRole('tab', { name: 'Git', exact: true })).toBeVisible()

  await writeFile(join(project, 'src', 'cart.ts'), 'export const total = 2\n')
  await writeFile(join(project, 'src', 'tax.ts'), 'export const rate = 0.1\n')
  await panel(`dispatchEvent(new Event('focus'))`)
  await expect.poll(() => rows('changes')).toEqual(['src/cart.ts', 'src/tax.ts'])

  await panel(`document.querySelector('#changes .file[data-path="src/cart.ts"]').click()`)
  await expect
    .poll(() => panel<string>(`document.querySelector('#changes .diff')?.textContent ?? ''`))
    .toContain('+export const total = 2')
  await capture('changes.png')

  await click('暂存 src/cart.ts')
  await expect.poll(() => rows('staged')).toEqual(['src/cart.ts'])
  await expect.poll(() => rows('changes')).toEqual(['src/tax.ts'])

  await panel(`(() => {
    const message = document.getElementById('message')
    message.value = 'fix cart total'
    message.dispatchEvent(new Event('input'))
    document.getElementById('commit').click()
  })()`)
  await expect.poll(() => git('log', '-1', '--format=%s %an')).toBe('fix cart total E2E')
  await expect.poll(() => rows('staged')).toEqual([])
  await expect
    .poll(() => panel<string>(`document.getElementById('push').textContent`))
    .toBe('推送 ↑1')
  await capture('committed.png')

  // Pushing leaves the machine, so it is confirmed even at full access.
  await panel(`document.getElementById('push').click()`)
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('插件 Git 请求')
  await expect(dialog).toContainText('推送 main 到 origin/main')
  await expect(dialog).toContainText('fix cart total')
  await page.screenshot({ path: join(artifacts, 'push-approval.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: '拒绝' }).click()
  expect(
    execFileSync(GIT.path, ['--git-dir', remote, 'log', '-1', '--format=%s'])
      .toString()
      .trim()
  ).toBe('init')

  await panel(`document.getElementById('push').click()`)
  await page.getByRole('alertdialog').getByRole('button', { name: '允许一次' }).click()
  await expect
    .poll(() =>
      execFileSync(GIT.path, ['--git-dir', remote, 'log', '-1', '--format=%s'])
        .toString()
        .trim()
    )
    .toBe('fix cart total')
  await expect.poll(() => panel<boolean>(`document.getElementById('push').hidden`)).toBe(true)
  await expect
    .poll(() => panel<string>(`document.getElementById('notice').textContent`))
    .toContain('已推送到 origin/main')
})

test('the bundled Git plugin is on by default, shown as built in, and can be turned off', async () => {
  await expect(launcher()).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  const row = page.locator('.plugin-row').filter({ hasText: '随 Pi Desktop 分发' })
  await expect(row.locator('.plugin-badge').first()).toHaveText('内置')
  const toggle = row.getByRole('switch', { name: 'Git Desktop 面板' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: join(artifacts, 'settings.png'), animations: 'disabled' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(launcher()).toHaveCount(0)
})
