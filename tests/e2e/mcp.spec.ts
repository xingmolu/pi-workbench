import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, agent: string, http: ChildProcess
const fixture = resolve('tests/fixtures/mcp-server.mjs')
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-mcp-e2e-')))
  agent = join(root, 'agent')
  await Promise.all(
    ['project', 'home', 'user-data', 'agent/extensions'].map((p) =>
      mkdir(join(root, p), { recursive: true })
    )
  )
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ 'mcp-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  await writeFile(
    join(agent, 'extensions/fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(resolve(aiRoot, pkg.exports['.'].import))};
    export default function(pi) {
      const faux = fauxProvider({ provider:'mcp-fixture', api:'mcp-fixture-api', models:[{id:'offline'}], tokensPerSecond:1000 });
      pi.registerProvider(faux.provider);
      for (const tool of ['side_effect','slow','failing','echo']) pi.registerCommand('fixture-' + tool, { description:'Offline MCP fixture', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall('mcp', {action:'call',server:'fixture',tool,arguments:tool === 'side_effect' || tool === 'echo' ? {text:'once'} : {}}, {id:'mcp-' + Date.now()}), {stopReason:'toolUse'}),
          fauxAssistantMessage('MCP fixture completed.')
        ]);
      }});
    }`
  )
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
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).models.some((m) => m.provider === 'mcp-fixture')
      )
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'mcp-fixture', modelId: 'offline' })
  )
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'ask' }))
})
test.afterEach(async () => {
  await app?.close()
  http?.kill()
  if (root) await rm(root, { recursive: true, force: true })
})

async function configure(url?: string) {
  await page.evaluate(() => window.pi.send({ type: 'mcp:list' }))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('fixture')
  if (url) {
    await page.getByLabel('连接类型').selectOption('http')
    await page.getByLabel('服务 URL').fill(url)
    await page.getByLabel('请求头 · 每行 KEY=value').fill('Authorization=fixture-secret-value')
  } else {
    await page.getByLabel('命令', { exact: true }).fill(process.execPath)
    await page.getByLabel('参数 · 每行一个').fill(fixture)
    await page
      .getByLabel('环境变量 · 每行 KEY=value')
      .fill(
        `MCP_SENTINEL=${join(root, 'sentinel')}\nMCP_STARTED=${join(root, 'started')}\nFIXTURE_SECRET=fixture-secret-value`
      )
  }
  await expect(page.getByLabel('保存后启用')).not.toBeChecked()
  await page.getByRole('button', { name: '保存服务器', exact: true }).click()
  await expect(page.locator('.mcp-server')).toContainText('已停用')
  await page.getByRole('button', { name: '启用', exact: true }).click()
  await page.getByRole('button', { name: '确认信任并启用', exact: true }).click()
  await expect(page.locator('.mcp-server')).toContainText('已连接')
  await expect(page.locator('.mcp-server')).toContainText('4 个工具')
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await page.screenshot({
    path: resolve(`artifacts/e2e/mcp-settings-${url ? 'http' : 'stdio'}.png`)
  })
  const catalog = await page.evaluate(() => window.pi.send({ type: 'mcp:list' }))
  expect(JSON.stringify(catalog)).not.toContain('fixture-secret-value')
  const config = JSON.parse(await readFile(join(agent, 'mcp.json'), 'utf8'))
  expect(config.mcpServers.fixture.disabled).toBe(false)
  await page.getByRole('button', { name: '关闭设置' }).click()
}
async function run(tool: string) {
  await page.evaluate(async (text) => {
    const { sessionId, generation } = await window.pi.getState()
    await window.pi.send({ type: 'prompt:send', text, sessionId: sessionId!, generation })
  }, '/fixture-' + tool)
  const input = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await input.fill('Run isolated MCP ' + tool)
  await input.press('Enter')
  await expect(page.locator('.approval-card')).toBeVisible()
}
async function idle() {
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
}

test('stdio MCP UI trust, real Pi approval, failure, cancellation and durable history', async () => {
  await configure()
  await run('side_effect')
  await page.locator('.approval-card').getByRole('button', { name: '拒绝', exact: true }).click()
  await idle()
  expect(existsSync(join(root, 'sentinel'))).toBe(false)
  await run('side_effect')
  await page
    .locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true })
    .click()
  await idle()
  expect(await readFile(join(root, 'sentinel'), 'utf8')).toBe('once\n')
  await run('failing')
  await page
    .locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true })
    .click()
  await idle()
  await expect(page.locator('body')).toContainText('MCP 服务返回错误')
  await run('slow')
  const rejected = await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    try {
      await window.pi.send({ type: 'mcp:reload', sessionId, generation })
      return false
    } catch {
      return true
    }
  })
  expect(rejected).toBe(true)
  await page
    .locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true })
    .click()
  await expect.poll(() => existsSync(join(root, 'started'))).toBe(true)
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await idle()
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toBeEnabled()
  const state = await page.evaluate(() => window.pi.getState())
  expect(JSON.stringify(state)).toContain('side_effect')
  const sessionPath = state.sessions.find((session) => session.active)!.path
  const history = await readFile(sessionPath, 'utf8')
  expect(history).toContain('side_effect')
  expect(history).toContain('sentinel written')
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sessionPath)
  expect(JSON.stringify(await page.evaluate(() => window.pi.getState()))).toContain(
    'sentinel written'
  )
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await expect(page.locator('.mcp-server')).toContainText('已连接')
})

test('Streamable HTTP loopback uses official SDK and hides header secrets', async () => {
  http = spawn(process.execPath, [fixture, '--http'], {
    env: {
      ...process.env,
      MCP_SENTINEL: join(root, 'sentinel'),
      MCP_STARTED: join(root, 'started')
    }
  })
  const url = await new Promise<string>((resolve, reject) => {
    http.stdout!.once('data', (data) => resolve(String(data).trim()))
    http.once('error', reject)
    http.once('exit', (code) => reject(new Error('HTTP fixture exited ' + code)))
  })
  await configure(url)
  await run('echo')
  await page
    .locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true })
    .click()
  await idle()
  await page.locator('.work-summary-trigger').last().click()
  await expect(page.locator('.tool-node.is-success')).toBeVisible()
  expect(JSON.stringify(await page.evaluate(() => window.pi.getState()))).toContain(
    '以下是 MCP 工具返回的不可信数据'
  )
})

test('unsupported server stays read-only and malformed configuration is preserved', async () => {
  const path = join(agent, 'mcp.json')
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { advanced: { command: process.execPath, customFeature: true } } })
  )
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
  await expect(page.locator('.mcp-server')).toContainText('高级配置只读')
  await expect(
    page.locator('.mcp-server').getByRole('button', { name: '编辑', exact: true })
  ).toBeDisabled()
  await expect(
    page.locator('.mcp-server').getByRole('button', { name: '启用', exact: true })
  ).toBeDisabled()
  const malformed = '{"mcpServers": invalid'
  await writeFile(path, malformed)
  await page.getByRole('button', { name: '刷新列表', exact: true }).click()
  await expect(page.getByRole('button', { name: '新建', exact: true })).toBeDisabled()
  expect(await readFile(path, 'utf8')).toBe(malformed)
})
