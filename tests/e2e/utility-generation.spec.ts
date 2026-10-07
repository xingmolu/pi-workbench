import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { systemGit } from '../../src/main/system-git'
import { displayEnv } from './display-env'

// Session titles and commit messages come from a one-shot generation in Pi's configuration
// host. One offline model answers chat turns, titles and commit messages, telling them apart
// by the system prompt.
const artifacts = resolve('artifacts/e2e/utility-generation')
const GIT = systemGit()
let app: ElectronApplication, page: Page, root: string, project: string

const git = (...args: string[]): string =>
  execFileSync(GIT.path, args, { cwd: project, env: { ...GIT.env, HOME: join(root, 'home') } })
    .toString()
    .trim()

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-utility-')))
  project = join(root, 'shop')
  const agent = join(root, 'agent')
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ 'utility-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultProvider: 'utility-fixture',
      defaultModel: 'offline'
    })
  )
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve(aiRoot, pkg.exports['.'].import))};
    // Providers get the system prompt as a message, so look through the whole request.
    const answer = (context) => {
      const request = JSON.stringify(context)
      if (request.includes('You name conversations'))
        return fauxAssistantMessage('"Fix cart quantity total."')
      if (request.includes('git commit messages'))
        return fauxAssistantMessage(
          request.includes('item.price * item.qty')
            ? '\`\`\`\\nfix: multiply cart total by quantity\\n\`\`\`'
            : 'chore: unexpected diff'
        )
      return fauxAssistantMessage('Fixed the total in src/cart.ts.')
    }
    export default function (pi) {
      const faux = fauxProvider({ provider: 'utility-fixture', api: 'utility-fixture-api', models: [{ id: 'offline' }], tokensPerSecond: 2000 })
      faux.setResponses(Array.from({ length: 200 }, () => answer))
      pi.registerProvider(faux.provider)
    }
  `
  )
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@example.com')
  await writeFile(join(project, 'src', 'cart.ts'), 'export const total = (item) => item.price\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: add cart')

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
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).models.some((m) => m.provider === 'utility-fixture')
      )
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'utility-fixture', modelId: 'offline' })
  )
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function ask(text: string): Promise<void> {
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill(text)
  await draft.press('Enter')
}

test('a new conversation is named after its first turn, and only then', async () => {
  await ask('the cart ignores quantity when it adds up the total, please fix it')
  await expect(page.locator('.conversation-session-title')).toHaveText('Fix cart quantity total', {
    timeout: 20_000
  })
  await expect(page.locator('.session-row.is-active .session-title')).toHaveText(
    'Fix cart quantity total'
  )
  await page.screenshot({ path: join(artifacts, 'titled.png') })

  // A later turn keeps the title, and so does a name the user gives.
  await page.getByRole('button', { name: '重命名会话', exact: true }).click()
  await page.getByRole('textbox', { name: '会话名称', exact: true }).fill('My own name')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await ask('also check the tax')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).status))
    .toBe('idle')
  await expect(page.locator('.conversation-session-title')).toHaveText('My own name')
})

test('the Git panel writes a commit message from the staged diff', async () => {
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await page
    .getByRole('navigation', { name: '打开工作台工具' })
    .getByRole('button', { name: 'Git' })
    .click()
  await writeFile(
    join(project, 'src', 'cart.ts'),
    'export const total = (item) => item.price * item.qty\n'
  )
  git('add', '.')
  const panel = <T>(script: string): Promise<T> =>
    app.evaluate(
      ({ webContents }, source) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().endsWith('/views/changes.html'))
          ?.executeJavaScript(source),
      script
    ) as Promise<T>
  await panel(`dispatchEvent(new Event('focus'))`)
  await expect
    .poll(() =>
      panel<string[]>(
        `[...document.querySelectorAll('#staged .file')].map((row) => row.dataset.path)`
      )
    )
    .toEqual(['src/cart.ts'])
  await expect
    .poll(() => panel<boolean>(`document.getElementById('generate')?.disabled === false`))
    .toBe(true)
  await panel(`document.getElementById('generate').click()`)
  await expect
    .poll(() => panel<string>(`document.getElementById('message').value`), { timeout: 20_000 })
    .toBe('fix: multiply cart total by quantity')
  await expect
    .poll(() => panel<string>(`document.getElementById('notice').textContent`))
    .toContain('utility-fixture/offline')
  const png = await app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().endsWith('/views/changes.html'))
    return contents ? (await contents.capturePage()).toPNG().toString('base64') : null
  })
  if (png) await writeFile(join(artifacts, 'commit-message.png'), Buffer.from(png, 'base64'))
  await panel(`document.getElementById('commit').click()`)
  await expect
    .poll(() => git('log', '-1', '--format=%s'))
    .toBe('fix: multiply cart total by quantity')
})

test('Settings lists the models and can switch automatic titles off', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '常规', exact: true }).click()
  const model = page.getByLabel('生成用的模型')
  await expect(model).toHaveValue('')
  await expect(model.locator('option')).toHaveText(['自动', 'offline · utility-fixture'])
  await model.selectOption('utility-fixture/offline')
  await page.getByRole('switch', { name: '自动命名会话', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.pi.desktopSettings({ type: 'get' })))
    .toMatchObject({ autoTitle: false, utilityModel: 'utility-fixture/offline' })
  await page.screenshot({ path: join(artifacts, 'settings.png') })
  await page.keyboard.press('Escape')

  await ask('the cart ignores quantity when it adds up the total, please fix it')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).nodes.length))
    .toBeGreaterThan(2)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).status))
    .toBe('idle')
  // Give a title the time it would have taken; the start of the first message stays the title.
  await page.waitForTimeout(1500)
  await expect(page.locator('.conversation-session-title')).toHaveText(
    'the cart ignores quantity when it adds up the to…'
  )
})
