import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const artifacts = resolve('artifacts/e2e/engine-accounts')
let app: ElectronApplication, page: Page, root: string, agent: string

/** Three providers the way a real setup looks: a few families, mixed capabilities. */
const PROVIDERS = {
  'acme-cloud': [
    {
      id: 'acme-pro-2',
      name: 'Acme Pro 2',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 400000
    },
    {
      id: 'acme-pro-2-mini',
      name: 'Acme Pro 2 mini',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 200000
    },
    { id: 'acme-fast', name: 'Acme Fast', reasoning: false, input: ['text'], contextWindow: 128000 }
  ],
  'north-ai': [
    {
      id: 'north-large',
      name: 'North Large',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1000000
    },
    {
      id: 'north-coder',
      name: 'North Coder',
      reasoning: false,
      input: ['text'],
      contextWindow: 256000
    }
  ],
  'local-lab': [
    {
      id: 'qwen-coder-32b',
      name: 'qwen-coder-32b',
      reasoning: false,
      input: ['text'],
      contextWindow: 32768
    }
  ]
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-model-picker-')))
  const project = join(root, 'shop')
  agent = join(root, 'agent')
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, pkg.exports['.'].import)
  const jwt = (email: string, plan: string): string =>
    [
      'e30',
      Buffer.from(
        JSON.stringify({
          'https://api.openai.com/profile': { email },
          'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: email }
        })
      ).toString('base64url'),
      'sig'
    ].join('.')
  const codex = (email: string, plan: string) => ({
    type: 'oauth',
    access: jwt(email, plan),
    refresh: 'r',
    expires: Date.now() + 864e5,
    accountId: email
  })
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({
      ...Object.fromEntries(
        Object.keys(PROVIDERS).map((id) => [id, { type: 'api_key', key: 'offline-only' }])
      ),
      'openai-codex': codex('robin@example.com', 'plus'),
      'openai-codex-acct-1a2b3c': codex('robin@company.com', 'team')
    })
  )
  await writeFile(
    join(agent, 'pi-multi-login.json'),
    JSON.stringify({ aliases: [{ base: 'openai-codex', suffix: 'acct-1a2b3c' }] })
  )
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }))
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider } from ${JSON.stringify(publicAI)};
    const providers = ${JSON.stringify(PROVIDERS)};
    export default function(pi) {
      for (const [provider, models] of Object.entries(providers))
        pi.registerProvider(fauxProvider({ provider, api: provider + '-api', models }).provider);
    }
  `
  )
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
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (await window.pi.getState()).models.filter((m) => m.provider === 'acme-cloud').length
        ),
      {
        timeout: 45_000,
        message: 'acme-cloud models should load after the project opens'
      }
    )
    .toBe(3)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'acme-cloud', modelId: 'acme-pro-2' })
  )
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('Settings lists subscription accounts by email, removes one, and remembers the default engine', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const accounts = page.getByRole('region', { name: '订阅账号' })
  await expect(accounts.getByText('robin@example.com', { exact: true })).toBeVisible()
  await expect(accounts).toContainText('ChatGPT Plus · 用于 Pi')
  await expect(accounts.getByText('robin@company.com', { exact: true })).toBeVisible()
  await expect(accounts).toContainText('ChatGPT Team · 用于 Pi')
  // Generated alias ids never show; rows are identified by email only.
  await expect(accounts).not.toContainText('acct-1a2b3c')
  await page.screenshot({ path: join(artifacts, 'accounts.png') })

  // The add menu offers each engine's declared account providers.
  await accounts.getByRole('button', { name: /添加订阅账号/ }).click()
  await expect(page.getByRole('menuitem', { name: /ChatGPT 账号.*用于 Pi/ }).first()).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Claude 账号/ })).toBeVisible()
  await page.keyboard.press('Escape')

  page.once('dialog', (dialog) => void dialog.accept())
  await accounts.getByRole('button', { name: 'robin@company.com 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '移除账号' }).click()
  await expect(accounts.getByText('robin@company.com', { exact: true })).toHaveCount(0)
  await expect(accounts.getByText('robin@example.com', { exact: true })).toBeVisible()
  const config = JSON.parse(await readFile(join(agent, 'pi-multi-login.json'), 'utf8'))
  expect(config.aliases).toEqual([])
  const auth = JSON.parse(await readFile(join(agent, 'auth.json'), 'utf8'))
  expect(auth['openai-codex-acct-1a2b3c']).toBeUndefined()
  expect(auth['openai-codex']).toBeDefined()

  const engines = page.getByRole('radiogroup', { name: '新会话默认引擎' })
  await engines.getByRole('radio', { name: /Claude Code/ }).click()
  await expect(engines.getByRole('radio', { name: /Claude Code/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  expect(await page.evaluate(() => window.pi.defaultRuntime())).toBe('claude')
  await engines.getByRole('radio', { name: /^Pi/ }).click()
  expect(await page.evaluate(() => window.pi.defaultRuntime())).toBe('pi')
})

test('the composer model picker titles subscription groups with the account email', async () => {
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.pi.getState()).accounts.map((a) => a.email))
    )
    .toContain('robin@example.com')
  await page.getByRole('button', { name: '选择模型' }).click()
  await expect(page.locator('.model-picker')).toContainText('robin@example.com')
  await expect(page.locator('.model-picker')).toContainText('Plus')
})

test('adds an API connection from a service preset', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const apis = page.getByRole('region', { name: '自定义端点' })
  await apis.getByRole('button', { name: '添加端点', exact: true }).click()
  const panel = page.getByRole('group', { name: '添加端点' })
  await expect(panel.getByRole('button', { name: /OpenRouter/ })).toBeVisible()
  await panel.screenshot({ path: join(artifacts, 'add-api-presets.png') })

  // Anthropic-compatible services can serve either engine, when Claude Code can start.
  const claudeReady = await page.evaluate(async () =>
    (await window.pi.runtimeAccounts()).some(
      (engine) => engine.runtimeId === 'claude' && !engine.error
    )
  )
  await panel.getByRole('button', { name: /^Anthropic/ }).click()
  await expect(panel.getByRole('group', { name: '用于哪些引擎' })).toHaveCount(
    claudeReady ? 1 : 0
  )
  await panel.getByRole('button', { name: '返回选择服务' }).click()

  await panel.getByRole('button', { name: /^自定义/ }).click()
  await expect(panel.getByRole('group', { name: '用于哪些引擎' })).toHaveCount(0)
  await panel.getByLabel('名称').fill('公司网关')
  await panel.getByLabel('服务地址').fill('https://llm.example.test/v1')
  await panel.getByLabel('API Key').fill('gateway-secret')
  await panel.getByLabel('手动填写模型 ID').fill('gw-large\ngw-small')
  await panel.screenshot({ path: join(artifacts, 'add-api-form.png') })
  await panel.getByRole('button', { name: '保存端点' }).click()
  await expect(panel).toHaveCount(0)
  await expect(apis).toContainText('公司网关')
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).models
          .filter((model) => model.id.startsWith('gw-'))
          .map((model) => model.id)
          .sort()
      )
    )
    .toEqual(['gw-large', 'gw-small'])
})
