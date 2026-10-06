import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createResponsesFixture } from '../../src/codex-host/responses-fixture'
import type { AgentSnapshot } from '../../src/shared/contracts'

/** Runs the real Codex CLI; set PI_DESKTOP_CODEX_EXECUTABLE to a downloaded `codex`. */
const executable = process.env.PI_DESKTOP_CODEX_EXECUTABLE
test.skip(!executable, 'PI_DESKTOP_CODEX_EXECUTABLE is not set')

let app: ElectronApplication, page: Page, root: string, project: string
let fixture: Awaited<ReturnType<typeof createResponsesFixture>>
const screenshots = resolve('artifacts/e2e/codex-runtime')

const jwt = (email: string, plan: string): string =>
  [
    'e30',
    Buffer.from(
      JSON.stringify({
        'https://api.openai.com/profile': { email },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: plan,
          chatgpt_account_id: `acct-${plan}`
        }
      })
    ).toString('base64url'),
    'sig'
  ].join('.')

const state = (): Promise<AgentSnapshot> => page.evaluate(() => window.pi.getState())

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-codex-e2e-')))
  project = join(root, 'shop')
  for (const directory of ['shop', 'home', 'agent', 'data']) await mkdir(join(root, directory))
  await mkdir(screenshots, { recursive: true })
  await writeFile(
    join(root, 'agent', 'auth.json'),
    JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: jwt('robin@example.com', 'plus'),
        refresh: 'r',
        expires: Date.now() + 864e5,
        accountId: 'acct-plus'
      }
    })
  )
  fixture = await createResponsesFixture()
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
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data'),
      PI_DESKTOP_CODEX_EXECUTABLE: executable!,
      PI_DESKTOP_E2E_CODEX_CONFIG: JSON.stringify(fixture.config)
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(async () => (await state()).ready).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect.poll(async () => (await state()).project?.path).toBe(project)
})

test.afterEach(async () => {
  await app?.close()
  await fixture?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('Codex chats on a ChatGPT account Pi lends it after the user allows it', async () => {
  await page.getByRole('button', { name: '选择 Agent 引擎' }).click()
  await page.getByRole('menuitem', { name: /Codex/ }).click()
  await expect.poll(async () => (await state()).runtime?.label).toBe('Codex')
  await expect
    .poll(async () => (await state()).accounts.map((account) => account.email ?? account.id))
    .toEqual(['codex-config', 'robin@example.com'])

  // Use the ChatGPT account Pi signed in; the first turn asks whether Codex may use it.
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'openai-codex', modelId: 'fixture-model' })
  )
  await expect.poll(async () => (await state()).activeProvider).toBe('openai-codex')
  await page.getByRole('textbox', { name: '任务输入' }).fill('hello codex')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  const grant = page.getByRole('alertdialog', { name: /允许 Codex 使用 robin@example\.com/ })
  await expect(grant).toBeVisible()
  await page.screenshot({ path: join(screenshots, 'grant.png') })
  await grant.getByRole('button', { name: '始终允许' }).click()
  await expect(page.getByText('Codex fixture reply.', { exact: true })).toBeVisible()

  // Commands wait for the desktop's approval card.
  await page.getByRole('textbox', { name: '任务输入' }).fill('please run command')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await page.screenshot({ path: join(screenshots, 'approval.png') })
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect.poll(async () => (await state()).busy).toBe(false)
  // The shell Codex runs writes CRLF on Windows.
  expect((await readFile(join(project, 'made-by-codex.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe(
    'fixture\n'
  )
  await page.screenshot({ path: join(screenshots, 'conversation.png') })

  // Settings shows who may use the login, and can take it back.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const accounts = page.getByRole('region', { name: '订阅账号' })
  await expect(accounts).toContainText('用于 Pi、Codex')
  await expect(accounts.getByText('robin@example.com', { exact: true })).toHaveCount(1)
  await page.screenshot({ path: join(screenshots, 'settings.png') })
  await accounts.getByRole('button', { name: 'robin@example.com 的更多操作' }).click()
  await page.getByRole('menuitem', { name: /不再允许 Codex 使用/ }).click()
  await expect(accounts).not.toContainText('Codex')
  expect(await page.evaluate(() => window.pi.credentialGrants())).toEqual([])

  // Tokens are for Main's broker only; the renderer cannot ask Pi for one.
  const leaked = await page.evaluate(() =>
    window.pi.send({ type: 'account:token', providerId: 'openai-codex' } as never).then(
      () => 'leaked',
      (error: Error) => error.message
    )
  )
  expect(leaked).toContain('仅供宿主内部使用')
})

test('one gateway added in Settings serves Pi and Codex, and Codex chats through it', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '添加端点', exact: true }).click()
  const panel = page.getByRole('group', { name: '添加端点' })
  await panel.getByRole('button', { name: /^自定义/ }).click()
  await panel.getByLabel('名称', { exact: true }).fill('团队网关')
  // The root address is enough: the desktop finds the /v1 API itself.
  await panel.getByLabel('服务地址', { exact: true }).fill(fixture.baseUrl.replace(/\/v1$/, ''))
  await panel.getByLabel('API Key', { exact: true }).fill('gateway-key')
  await panel.getByRole('button', { name: '测试并拉取模型', exact: true }).click()
  const detected = panel.getByRole('group', { name: '检测结果' })
  await expect(detected.locator('li.is-ok')).toHaveText(['OpenAI Responses'])
  await expect(panel.getByLabel('服务地址', { exact: true })).toHaveValue(fixture.baseUrl)
  await expect(panel.getByLabel('接口协议', { exact: true })).toHaveValue('openai-responses')
  const engines = panel.getByRole('group', { name: '用于哪些引擎' })
  await expect(engines.getByLabel('Codex')).toBeChecked()
  // Claude Code is offered nothing here: the gateway has no Anthropic route.
  const claudeReady = await page.evaluate(async () =>
    (await window.pi.runtimeAccounts()).some(
      (engine) => engine.runtimeId === 'claude' && !engine.error
    )
  )
  await expect(engines.getByLabel('Claude Code')).toHaveCount(0)
  if (claudeReady) await expect(panel).toContainText('Claude Code 只支持 Anthropic Messages 协议')
  await panel.screenshot({ path: join(screenshots, 'gateway-detected.png') })
  await panel.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(panel).toHaveCount(0)

  // One service, one row, used by both engines.
  const row = section.locator('.acct-endpoint-row', { hasText: '团队网关' })
  await expect(row).toHaveCount(1)
  await expect(row.locator('.acct-engine-tag')).toHaveText(['Pi', 'Codex'])
  await page.screenshot({ path: join(screenshots, 'gateway-list.png') })
  await page.getByRole('button', { name: '关闭设置' }).click()

  // A Codex chat on the gateway sends the gateway's key and the chosen model.
  await page.getByRole('button', { name: '选择 Agent 引擎' }).click()
  await page.getByRole('menuitem', { name: /Codex/ }).click()
  await expect.poll(async () => (await state()).runtime?.label).toBe('Codex')
  const gateway = await expect
    .poll(async () => (await state()).accounts.find((account) => account.name === '团队网关')?.id)
    .toMatch(/^codex-api-/)
    .then(async () => (await state()).accounts.find((account) => account.name === '团队网关')!.id)
  await page.evaluate(
    (providerId) => window.pi.send({ type: 'model:set', providerId, modelId: 'fixture-model' }),
    gateway
  )
  const before = fixture.requests.length
  await page.getByRole('textbox', { name: '任务输入' }).fill('hello gateway')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(page.getByText('Codex fixture reply.', { exact: true })).toBeVisible()
  expect(fixture.requests.slice(before)[0]).toMatchObject({
    authorization: 'Bearer gateway-key',
    model: 'fixture-model'
  })
})
