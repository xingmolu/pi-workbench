import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { systemGit } from '../../src/main/system-git'
import { displayEnv } from './display-env'

const artifacts = resolve('artifacts/e2e/code-review')
const GIT = systemGit()
let app: ElectronApplication, page: Page, root: string, project: string, github: Server
const requests: { method: string; path: string; body: unknown; auth?: string }[] = []

const git = (...args: string[]): string =>
  execFileSync(GIT.path, args, { cwd: project, env: { ...GIT.env, HOME: join(root, 'home') } })
    .toString()
    .trim()

const pull = (
  number: number,
  title: string,
  author: string,
  extra = {}
): Record<string, unknown> => ({
  number,
  title,
  user: { login: author },
  draft: false,
  head: { ref: `branch-${number}`, sha: `${number}`.repeat(40).slice(0, 40) },
  base: { ref: 'main' },
  updated_at: new Date().toISOString(),
  html_url: `https://github.com/acme/shop/pull/${number}`,
  requested_reviewers: [],
  ...extra
})

/** Just enough of the GitHub REST API for the review page. */
function fakeGitHub(): Server {
  const routes: Record<string, unknown> = {
    'GET /user': { login: 'me' },
    'GET /repos/acme/shop/pulls': [
      pull(7, 'Add cart totals', 'me'),
      pull(8, 'Tax rules', 'alice', { requested_reviewers: [{ login: 'me' }] })
    ],
    'GET /repos/acme/shop/pulls/7': pull(7, 'Add cart totals', 'me', {
      body: '## Why\n\nTotals now include **tax**.\n\n- Adds `rate`\n- [x] Tested',
      state: 'open',
      mergeable: true,
      mergeable_state: 'clean',
      additions: 1,
      deletions: 1,
      changed_files: 1
    }),
    'GET /repos/acme/shop/commits/7777777777777777777777777777777777777777/check-runs': {
      check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }]
    },
    'GET /repos/acme/shop/pulls/7/reviews': [],
    'GET /repos/acme/shop/pulls/7/files': [
      {
        filename: 'src/cart.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-export const total = 1\n+export const total = 3'
      }
    ],
    'PUT /repos/acme/shop/pulls/7/merge': { merged: true },
    'POST /repos/acme/shop/issues/7/comments': { html_url: 'https://github.com/acme/shop/pull/7#c' }
  }
  return createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0]
      requests.push({
        method: request.method ?? '',
        path,
        body: body ? JSON.parse(body) : undefined,
        auth: request.headers.authorization
      })
      const value = routes[`${request.method} ${path}`]
      response.writeHead(value === undefined ? 404 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value ?? { message: 'Not Found' }))
    })
  })
}

test.beforeEach(async () => {
  requests.length = 0
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-code-review-')))
  project = join(root, 'shop')
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'agent')),
    mkdir(join(root, 'user-data')),
    mkdir(artifacts, { recursive: true })
  ])
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@example.com')
  await writeFile(join(project, 'src', 'cart.ts'), 'export const total = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // The remote is on GitHub; its main is the first commit, as if fetched.
  git('remote', 'add', 'origin', 'https://github.com/acme/shop.git')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await writeFile(join(project, 'src', 'tax.ts'), 'export const rate = 0.1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'add tax rate')
  await writeFile(join(project, 'src', 'cart.ts'), 'export const total = 2\n')

  // An offline model, so the composer accepts the review request.
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const aiPackage = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await mkdir(join(root, 'agent/extensions'))
  await writeFile(
    join(root, 'agent/auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(root, 'agent/extensions/fixture.ts'),
    `import { fauxProvider } from ${JSON.stringify(resolve(aiRoot, aiPackage.exports['.'].import))}; export default function(pi) { const faux = fauxProvider({ provider: 'fixture', api: 'fixture-api', models: [{ id: 'offline' }] }); pi.registerProvider(faux.provider); }`
  )

  github = fakeGitHub()
  await new Promise<void>((done) => github.listen(0, '127.0.0.1', done))
  const port = (github.address() as AddressInfo).port
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...displayEnv(),
      GITHUB_TOKEN: 'e2e-token-0123456789abcdef',
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_GITHUB_API: `http://127.0.0.1:${port}`,
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
})

test.afterEach(async () => {
  await app?.close()
  await new Promise((done) => github?.close(done))
  if (root) await rm(root, { recursive: true, force: true })
})

/** Runs a script inside the review page. */
function review<T>(script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, source) =>
      webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith('/views/review.html'))
        ?.executeJavaScript(source),
    script
  ) as Promise<T>
}

const text = (selector: string): Promise<string> =>
  review<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)

const clickItem = (title: string): Promise<void> =>
  review(
    `[...document.querySelectorAll('.item')].find((item) => item.querySelector('.item-title').textContent === ${JSON.stringify(title)})?.click()`
  )

const clickButton = (label: string): Promise<void> =>
  review(
    `[...document.querySelectorAll('#detail button')].find((button) => button.textContent === ${JSON.stringify(label)})?.click()`
  )

/** Saves the review page in the light theme and again in the dark one. Xvfb has no system
 * theme to follow, so the dark capture emulates the media query in the page itself. */
async function capture(name: string): Promise<void> {
  await shot(name)
  await emulateDark(true)
  await shot(name.replace('.png', '-dark.png'))
  await emulateDark(false)
}

function emulateDark(dark: boolean): Promise<void> {
  return app.evaluate(async ({ webContents }, on) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().endsWith('/views/review.html'))
    if (!contents) return
    if (!contents.debugger.isAttached()) contents.debugger.attach()
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }]
    })
    await new Promise((done) => setTimeout(done, 100))
  }, dark)
}

async function shot(name: string): Promise<void> {
  const png = await app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().endsWith('/views/review.html'))
    return contents ? (await contents.capturePage()).toPNG().toString('base64') : null
  })
  if (png) await writeFile(join(artifacts, name), Buffer.from(png, 'base64'))
}

test('the code review page shows local changes and pull requests, merges and hands reviews and questions to Pi', async () => {
  const entry = page
    .getByRole('navigation', { name: '活动栏' })
    .getByRole('button', { name: '代码审查', exact: true })
  await entry.click()
  await expect(page.getByRole('main', { name: '代码审查' })).toBeVisible()

  await expect.poll(() => text('#repo')).toContain('acme/shop')
  await expect
    .poll(() => text('#sections'))
    .toMatch(/未提交的改动.*未推送的提交.*Add cart totals.*Tax rules/s)
  // Uncommitted changes open first, with the working-tree diff.
  await expect.poll(() => text('#detail .diffs')).toContain('+export const total = 2')
  await capture('local.png')

  await clickItem('未推送的提交')
  await expect.poll(() => text('#detail .commits')).toContain('add tax rate')
  await expect.poll(() => text('#detail .diffs')).toContain('+export const rate = 0.1')

  await clickItem('Add cart totals')
  // The description is Markdown, rendered as elements rather than raw text.
  await expect.poll(() => text('#detail .description h3')).toBe('Why')
  expect(await text('#detail .description strong')).toBe('tax')
  expect(await text('#detail .description li code')).toBe('rate')
  expect(await text('#detail .facts')).toContain('可以合并，没有冲突')
  expect(await text('#detail .checks')).toContain('verify')
  await capture('summary.png')
  await review(`[...document.querySelectorAll('.tab')][1].click()`)
  await expect.poll(() => text('#detail .diffs')).toContain('+export const total = 3')
  await capture('changes.png')
  await review(`[...document.querySelectorAll('.tab')][0].click()`)

  // Merging leaves the machine, so it is confirmed; it sends the head the user saw.
  await review(`document.querySelector('[aria-label="合并方式"]').click()`)
  await review(
    `[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent === '压缩合并').click()`
  )
  await expect
    .poll(() => review<string>(`document.querySelector('.split-main').title`))
    .toBe('压缩合并')
  await clickButton('合并')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('合并拉取请求 #7')
  await expect(dialog).toContainText('Add cart totals')
  await dialog.getByRole('button', { name: '允许一次' }).click()
  await expect
    .poll(() => requests.find(({ method }) => method === 'PUT'))
    .toMatchObject({
      path: '/repos/acme/shop/pulls/7/merge',
      body: { merge_method: 'squash', sha: '7'.repeat(40) },
      auth: 'Bearer e2e-token-0123456789abcdef'
    })

  // Reviewing with Pi opens a new conversation with the request in its composer.
  await clickButton('用 Pi 审查')
  await expect(page.getByRole('main', { name: '代码审查' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '任务输入' })).toHaveValue(
    /请审查拉取请求 #7「Add cart totals」/
  )
  await page.screenshot({ path: join(artifacts, 'review-draft.png') })

  // The ask box at the bottom sends a question about the open pull request to Pi.
  await entry.click()
  await expect(page.getByRole('main', { name: '代码审查' })).toBeVisible()
  await expect
    .poll(() => review<string>(`document.querySelector('.ask textarea')?.placeholder ?? ''`))
    .toBe('就这些未提交的改动提问')
  await clickItem('Add cart totals')
  await expect
    .poll(() => review<string>(`document.querySelector('.ask textarea')?.placeholder ?? ''`))
    .toBe('就此 Pull Request 提问')
  await capture('ask.png')
  await review(`(() => {
    const input = document.querySelector('.ask textarea')
    input.value = '为什么税率放在常量里？'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await expect(page.getByRole('main', { name: '代码审查' })).toHaveCount(0)
  const composer = page.getByRole('textbox', { name: '任务输入' })
  await expect(composer).toHaveValue(/关于拉取请求 #7「Add cart totals」/)
  await expect(composer).toHaveValue(/为什么税率放在常量里？/)

  // Settings shows where the GitHub token comes from.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '代码托管' }).click()
  await expect(page.getByText('已登录为 me')).toBeVisible()
  await expect(page.getByText('来源：环境变量 GH_TOKEN / GITHUB_TOKEN')).toBeVisible()
})
