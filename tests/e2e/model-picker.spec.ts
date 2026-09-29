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

const artifacts = resolve('artifacts/e2e/model-picker')
let app: ElectronApplication, page: Page, root: string

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
  const agent = join(root, 'agent')
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
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.keys(PROVIDERS).map((id) => [id, { type: 'api_key', key: 'offline-only' }])
      )
    )
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
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.pi.getState()).models.filter((m) => m.provider === 'acme-cloud').length
      )
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

test('the model picker fits the window, shows capabilities, remembers recents and sets reasoning effort', async () => {
  const chip = page.getByRole('button', { name: '选择模型' })
  await chip.click()
  const picker = page.locator('.model-picker')
  await expect(picker).toBeVisible()
  await page.waitForTimeout(250)
  // The whole popover, search box included, stays inside the window.
  const box = (await picker.boundingBox())!
  const viewport =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  await expect(page.getByRole('combobox', { name: '搜索账号与模型' })).toBeInViewport()
  const row = picker.locator('[cmdk-item]').filter({ hasText: 'North Large' })
  await expect(row.locator('.model-context')).toHaveText('1M')
  await expect(row.locator('.model-tag')).toHaveText(['推理', '图片'])
  // Codex is not signed in here, so the picker offers it.
  await expect(picker.getByRole('button', { name: '登录 Codex' })).toHaveCount(1)
  await page.screenshot({ path: join(artifacts, 'open.png') })

  // Reasoning effort for the current (reasoning) model.
  const levels = picker.getByRole('radiogroup', { name: '思考强度' })
  await expect(levels).toBeVisible()
  await levels.getByRole('radio', { name: '高', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).thinking?.level))
    .toBe('high')
  await expect(levels.getByRole('radio', { name: '高', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.keyboard.press('Escape')
  await expect(chip).toContainText('高')

  // Search, then choose with the keyboard; a model without reasoning hides the effort row.
  await chip.click()
  await page.getByRole('combobox', { name: '搜索账号与模型' }).fill('fast')
  await page.screenshot({ path: join(artifacts, 'search.png') })
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeModel))
    .toBe('acme-fast')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).thinking ?? null))
    .toBeNull()

  // Two choices later, recents lead the list.
  await chip.click()
  await picker.locator('[cmdk-item]').filter({ hasText: 'North Coder' }).first().click()
  await chip.click()
  const recent = picker.locator('[cmdk-group]').filter({ hasText: '最近使用' })
  await expect(recent.locator('[cmdk-item]')).toHaveCount(2)
  await expect(picker.getByRole('radiogroup', { name: '思考强度' })).toHaveCount(0)
  await page.screenshot({ path: join(artifacts, 'recents.png') })
})
