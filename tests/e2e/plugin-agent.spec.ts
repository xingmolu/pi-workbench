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

const artifacts = resolve('artifacts/e2e/plugin-agent')
let app: ElectronApplication, page: Page, root: string, project: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-plugin-agent-')))
  project = join(root, 'shop')
  const agent = join(root, 'agent')
  const plugin = join(agent, 'desktop-plugins', 'tax')
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(join(plugin, 'skills', 'tax-policy'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, pkg.exports['.'].import)
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ 'coding-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider:'coding-fixture', api:'coding-fixture-api', models:[{id:'offline'}], tokensPerSecond:400, tokenSize:{min:4,max:4} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('tax-fixture', { description:'Calls a plugin tool', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('acme_tax__rate', {region:'shanghai'}, {id:'rate-' + Date.now()})], {stopReason:'toolUse'}),
          fauxAssistantMessage(fauxText('查到了：上海税率 6%。'))
        ]);
      }});
    }
  `
  )
  await writeFile(
    join(plugin, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.tax',
      version: '1.0.0',
      name: 'Tax',
      engines: { piDesktop: '^0.1.0' },
      main: 'main.js',
      permissions: ['agent.tools', 'agent.skills'],
      contributes: {
        agentTools: [
          {
            name: 'rate',
            title: '税率查询',
            description: 'Look up the sales tax rate of a region.',
            parameters: {
              type: 'object',
              properties: { region: { type: 'string' } },
              required: ['region']
            }
          }
        ],
        skills: ['skills']
      }
    })
  )
  await writeFile(
    join(plugin, 'main.js'),
    `module.exports = { async onLoad() {
      await pi.agent.registerTool({ name: 'rate', run: async (input) => '税率 ' + input.region + ': 6%' })
    } }`
  )
  await writeFile(
    join(plugin, 'skills', 'tax-policy', 'SKILL.md'),
    '---\nname: tax-policy\ndescription: How the shop applies sales tax.\n---\n\nAlways quote the rate with a percent sign.\n'
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
      page.evaluate(async () =>
        (await window.pi.getState()).models.some((m) => m.provider === 'coding-fixture')
      )
    )
    .toBe(true)
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function enablePlugin(): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  const row = page.locator('.plugin-row').filter({ hasText: 'Tax' })
  await row.getByRole('switch', { name: 'Tax Desktop 面板' }).click()
  const review = row.getByRole('group', { name: '授权 Tax' })
  await expect(review).toContainText('agent.tools')
  await expect(review).toContainText('agent.skills')
  await page.screenshot({ path: join(artifacts, 'grant.png'), animations: 'disabled' })
  await review.getByRole('button', { name: '授权并启用' }).click()
  await expect(row).toContainText('进程：运行中')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  // Plugin contributions apply to sessions created after the plugin is enabled.
  await page.evaluate(() =>
    window.pi.send({ type: 'session:new', providerId: 'coding-fixture', modelId: 'offline' })
  )
}

async function run(command: string): Promise<void> {
  await page.evaluate(async (text) => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({ type: 'prompt:send', text, sessionId: sessionId!, generation })
  }, command)
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.fill('上海的税率是多少？')
  await draft.press('Enter')
}

test('a plugin agent tool is asked for at the ask level and runs in the plugin process', async () => {
  await enablePlugin()
  await run('/tax-fixture')
  const card = page.locator('.approval-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Tax')
  await expect(card).toContainText('shanghai')
  await page.screenshot({ path: join(artifacts, 'approval.png'), animations: 'disabled' })
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(page.locator('.assistant-node').last()).toContainText('上海税率 6%')
  await expect(page.locator('.tool-output').last()).toContainText('税率 shanghai: 6%')

  // The plugin's skill is delivered to the session too.
  const catalog = await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({ type: 'skills:list', sessionId: sessionId!, generation })
  })
  expect(JSON.stringify(catalog)).toContain('tax-policy')

  const audit = await readFile(join(root, 'agent', 'pi-desktop', 'plugin-audit.jsonl'), 'utf8')
  expect(audit).toContain('"method":"tool:rate","outcome":"ok"')
})

test('a plugin agent tool runs without asking at full access and is refused when declined', async () => {
  await enablePlugin()
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await run('/tax-fixture')
  await expect(page.locator('.assistant-node').last()).toContainText('上海税率 6%')
  await expect(page.locator('.approval-card')).toHaveCount(0)
  await page.screenshot({ path: join(artifacts, 'open.png'), animations: 'disabled' })

  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'ask' }))
  await run('/tax-fixture')
  const card = page.locator('.approval-card')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '拒绝' }).click()
  await expect(page.locator('.tool-node, .tool-output').last()).toContainText('拒绝')
})
