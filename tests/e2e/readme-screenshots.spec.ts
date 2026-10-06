import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'
import { openWorkbenchTool } from './workbench-helpers'

/**
 * The README's screenshots, taken from the real app with offline models and a local gateway.
 * Opt-in, since it rewrites tracked images:
 *   npm run build && PI_DESKTOP_README_SCREENSHOTS=1 \
 *     PI_DESKTOP_CODEX_EXECUTABLE="$(node scripts/fetch-engine.mjs codex .engines)" \
 *     PI_DESKTOP_CLAUDE_EXECUTABLE="$(node scripts/fetch-engine.mjs claude .engines)" \
 *     npx playwright test tests/e2e/readme-screenshots.spec.ts
 */
test.skip(!process.env.PI_DESKTOP_README_SCREENSHOTS, 'PI_DESKTOP_README_SCREENSHOTS is not set')

const out = resolve('.github/screenshots')
const SOURCE = `export function total(items: { price: number; qty: number }[]): number {
  let sum = 0
  for (const item of items) {
    sum += item.price
  }
  return sum
}

export function format(value: number): string {
  return '$' + value
}
`
const ANSWER = [
  '已修复 `total()` 漏乘数量的问题，并补了一个回归测试。',
  '',
  '**改动**',
  '- `src/cart.ts`：累加时使用 `item.price * item.qty`；`format()` 保留两位小数。',
  '- `src/cart.test.ts`：新增覆盖多件商品的用例。',
  '',
  '| 用例 | 结果 |',
  '| --- | --- |',
  '| 单件商品 | 通过 |',
  '| 多件商品 | 通过 |'
].join('\n')

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

/** A gateway that speaks every protocol, as the probe sees one. */
function gatewayServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(
        JSON.stringify({
          data: ['deepseek-v3', 'kimi-k2', 'qwen3-coder', 'glm-4.6'].map((id) => ({ id }))
        })
      )
      return
    }
    if (
      request.method === 'POST' &&
      ['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(request.url ?? '')
    ) {
      response.writeHead(400).end(JSON.stringify({ error: { message: 'model is required' } }))
      return
    }
    response.writeHead(404).end('{}')
  })
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    )
  )
}

let app: ElectronApplication,
  page: Page,
  root: string,
  project: string,
  gateway: Awaited<ReturnType<typeof gatewayServer>>

test.beforeEach(async () => {
  test.setTimeout(300_000)
  await mkdir(out, { recursive: true })
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-readme-')))
  project = join(root, 'shop')
  const agent = join(root, 'agent')
  const userData = join(root, 'user-data')
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(userData, 'runtimes', 'claude', 'config'), { recursive: true }),
    mkdir(join(agent, 'extensions'), { recursive: true })
  ])
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, pkg.exports['.'].import)
  const account = (email: string, plan: string) => ({
    type: 'oauth',
    access: jwt(email, plan),
    refresh: 'r',
    expires: Date.now() + 864e5,
    accountId: email
  })
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({
      deepseek: { type: 'api_key', key: 'offline-only' },
      'openai-codex': account('robin@example.com', 'plus')
    })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  // Claude Code subscription logins, listed by email (fake, offline).
  await writeFile(
    join(userData, 'runtimes', 'claude', 'config', 'desktop.json'),
    JSON.stringify({
      accounts: [{ id: 'claude-readme01', email: 'robin@studio.dev', plan: 'Max' }]
    })
  )
  const file = join(project, 'src', 'cart.ts')
  const spec = join(project, 'src', 'cart.test.ts')
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider:'deepseek', api:'deepseek-api', models:[{id:'deepseek-v3', name:'DeepSeek V3', reasoning:true, contextWindow:128000}], tokensPerSecond:400, tokenSize:{min:4,max:4} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('readme-fix', { description:'README scene', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxThinking('先看一下 cart.ts 的实现，确认合计逻辑。'), fauxToolCall('read', {path:${JSON.stringify(file)}}, {id:'read-cart'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('edit', {path:${JSON.stringify(file)}, edits:[
            {oldText:'    sum += item.price\\n', newText:'    sum += item.price * item.qty\\n'},
            {oldText:"  return '$' + value\\n", newText:"  return '$' + value.toFixed(2)\\n"}
          ]}, {id:'edit-cart'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('write', {path:${JSON.stringify(spec)}, content:"import { total } from './cart'\\n\\ntest('multiplies quantity', () => {\\n  expect(total([{ price: 2, qty: 3 }])).toBe(6)\\n})\\n"}, {id:'write-test'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('bash', {command:'printf "2 passed"'}, {id:'run-tests'})], {stopReason:'toolUse'}),
          fauxAssistantMessage(fauxText(${JSON.stringify(ANSWER)}))
        ]);
      }});
      pi.registerCommand('readme-approval', { description:'README approval scene', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('edit', {path:${JSON.stringify(file)}, edits:[
            {oldText:'  let sum = 0\\n', newText:'  let sum = 0 // cents\\n'}
          ]}, {id:'edit-approval'})], {stopReason:'toolUse'}),
          fauxAssistantMessage('完成。')
        ]);
      }});
    }
  `
  )
  await writeFile(file, SOURCE)
  await writeFile(join(project, 'README.md'), '# Shop\n')
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: project,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Robin',
        GIT_AUTHOR_EMAIL: 'robin@example.com',
        GIT_COMMITTER_NAME: 'Robin',
        GIT_COMMITTER_EMAIL: 'robin@example.com'
      }
    })
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'Shop')
  gateway = await gatewayServer()
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'zh_CN.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: userData,
      // Containers run as root, where Claude Code wants to know it is sandboxed.
      ...(process.getuid?.() === 0 ? { IS_SANDBOX: '1' } : {}),
      ...(process.env.PI_DESKTOP_CODEX_EXECUTABLE
        ? { PI_DESKTOP_CODEX_EXECUTABLE: process.env.PI_DESKTOP_CODEX_EXECUTABLE }
        : {}),
      ...(process.env.PI_DESKTOP_CLAUDE_EXECUTABLE
        ? { PI_DESKTOP_CLAUDE_EXECUTABLE: process.env.PI_DESKTOP_CLAUDE_EXECUTABLE }
        : {})
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).ready), { timeout: 60_000 })
    .toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await window.pi.getState()).models.some((model) => model.provider === 'deepseek')
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'deepseek', modelId: 'deepseek-v3' })
  )
})

test.afterEach(async () => {
  await app?.close()
  gateway?.server.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function run(command: string, prompt: string): Promise<void> {
  await page.evaluate(async (text) => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({ type: 'prompt:send', text, sessionId: sessionId!, generation })
  }, command)
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill(prompt)
  await draft.press('Enter')
}

async function shot(name: string): Promise<void> {
  // Let hover and transition states settle; screenshots are for people.
  await page.mouse.move(0, 899)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, name), animations: 'disabled' })
}

test('README screenshots', async () => {
  test.setTimeout(240_000)

  // A finished change: the work, the reply and the diff, with the review open beside it.
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'deepseek', modelId: 'deepseek-v3' })
  )
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await run('/readme-fix', 'total() 算出来的金额不对，帮我修一下并补个测试')
  await expect(page.locator('.assistant-node').last()).toContainText('回归测试')
  await page.locator('.work-summary-trigger').last().click()
  await openWorkbenchTool(page, '文件')
  const files = page.getByRole('region', { name: '项目文件' })
  await files.getByRole('button', { name: 'src', exact: true }).click()
  await files.getByRole('button', { name: 'cart.ts', exact: true }).click()
  await expect(files.locator('pre')).toContainText('item.qty')
  await page.locator('.conversation-scroll').evaluate((element) => element.scrollTo(0, 0))
  await shot('conversation.png')

  // Models: one gateway, probed once, for every engine.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '添加端点', exact: true }).click()
  const panel = page.getByRole('group', { name: '添加端点' })
  await panel.getByRole('button', { name: /^自定义/ }).click()
  await panel.getByLabel('名称', { exact: true }).fill('团队网关')
  await panel.getByLabel('服务地址', { exact: true }).fill(gateway.url)
  await panel.getByLabel('API Key', { exact: true }).fill('sk-team-gateway')
  await panel.getByRole('button', { name: '测试并拉取模型', exact: true }).click()
  await expect(panel.getByRole('group', { name: '检测结果' }).locator('li.is-ok')).toHaveCount(3)
  const engines = panel.getByRole('group', { name: '用于哪些引擎' })
  for (const engine of ['Pi', 'Claude Code', 'Codex'])
    await expect(engines.getByRole('checkbox', { name: engine, exact: true })).toBeChecked()
  await panel.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await shot('gateway.png')
  await panel.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(section.locator('.acct-endpoint-row', { hasText: '团队网关' })).toBeVisible()
  await page
    .locator('.settings-content, .sp-page, [role="dialog"] main')
    .first()
    .evaluate((element) => element.scrollTo(0, 0))
    .catch(() => undefined)
  await shot('engines.png')
  await page.getByRole('button', { name: '关闭设置' }).click()

  // The model picker: every engine's connections and their models in one place.
  await page.getByRole('button', { name: '选择模型' }).click()
  await page.getByRole('option', { name: /团队网关/ }).click()
  await page.waitForTimeout(400)
  await shot('models.png')
  await page.keyboard.press('Escape')

  // Approval: the proposed diff before anything is written.
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'ask' }))
  await run('/readme-approval', '在 sum 上加个单位注释')
  await expect(page.locator('.approval-card')).toBeVisible()
  await page.locator('.approval-card').scrollIntoViewIfNeeded()
  await shot('approval.png')
  await page.getByRole('button', { name: '拒绝', exact: true }).first().click()
})
