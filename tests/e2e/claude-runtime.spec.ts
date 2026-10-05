import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createClaudeHttpFixture } from '../../src/claude-host/sdk-fixture'
import type { AgentSnapshot } from '../../src/shared/contracts'
import { displayEnv } from './display-env'

let app: ElectronApplication, page: Page, root: string, project: string
let fixture: Awaited<ReturnType<typeof createClaudeHttpFixture>>
const screenshots = resolve('artifacts/e2e/runtime-workbench')
const errors: string[] = []
async function state(): Promise<AgentSnapshot> {
  return page.evaluate(() => window.pi.getState())
}
async function send(text: string) {
  await page.getByRole('textbox', { name: '任务输入' }).fill(text)
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
}
async function idle() {
  await expect.poll(async () => (await state()).busy).toBe(false)
}
async function selectEngine(label: string) {
  await page.getByRole('button', { name: '选择 Agent 引擎' }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
  await expect.poll(async () => (await state()).runtime?.label).toBe(label)
}
async function launch(attempt = 1): Promise<void> {
  // Electron occasionally segfaults while starting under xvfb right after the previous instance
  // closed; that happens before any app code runs, so one fresh launch is tried.
  if (attempt === 1)
    return launch(2).catch((error: Error) => {
      if (!/Process failed to launch/.test(error.message)) throw error
      return launch(3)
    })
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'pi'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data'),
      // These inherited credentials must never be used by the Claude adapter.
      ANTHROPIC_API_KEY: 'inherited-bait',
      CLAUDE_CONFIG_DIR: join(root, 'cli-config')
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect.poll(async () => (await state()).ready).toBe(true)
}

test.beforeEach(async () => {
  errors.length = 0
  root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-sdk-e2e-')))
  project = join(root, 'project')
  for (const directory of ['project', 'home', 'pi/extensions', 'data', 'cli-config'])
    await mkdir(join(root, directory), { recursive: true })
  await mkdir(screenshots, { recursive: true })
  await writeFile(join(root, 'cli-config/bait.txt'), 'User CLI data stays untouched.')
  const ai = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(ai, 'package.json'), 'utf8'))
  await writeFile(
    join(root, 'pi/auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'pi-fixture' } })
  )
  await writeFile(
    join(root, 'pi/extensions/fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve(ai, pkg.exports['.'].import))};
    export default function(pi) { const faux = fauxProvider({provider:'fixture',api:'fixture',models:[{id:'offline'}],tokensPerSecond:1000});
      faux.setResponses([fauxAssistantMessage('Pi fixture reply.'),fauxAssistantMessage('Pi fixture reply.')]);pi.registerProvider(faux.provider); }
  `
  )
  fixture = await createClaudeHttpFixture({
    cwd: project,
    delayMs: 120,
    childDelayMs: 400,
    // Slow enough that the long reply is still streaming while the test types and presses Stop.
    streamDelayMs: 25
  })
  await launch()
  await selectEngine('Claude Code')
  expect((await state()).accounts.find((account) => account.id === 'anthropic')?.connected).toBe(
    false
  )
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page
    .getByRole('region', { name: '自定义端点' })
    .getByRole('button', { name: '添加端点', exact: true })
    .click()
  const panel = page.getByRole('group', { name: '添加端点' })
  await panel.getByRole('button', { name: /^Anthropic/ }).click()
  await panel.getByRole('radio', { name: '用于 Claude Code' }).click()
  await panel.getByLabel('服务地址').fill(fixture.baseUrl)
  await panel.getByLabel('API Key').fill('fixture-key')
  await panel.getByRole('button', { name: '保存端点' }).click()
  await expect(panel).toHaveCount(0)
  expect(fixture.requests.filter((request) => request.path.includes('/messages'))).toHaveLength(0)
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.evaluate(
    (cwd) => window.pi.send({ type: 'project:open', cwd, runtimeId: 'claude' }),
    project
  )
  await expect(page.getByRole('textbox', { name: '任务输入' })).toBeEnabled()
})
test.afterEach(async () => {
  await app?.close()
  await fixture?.close()
  await rm(root, { recursive: true, force: true })
  expect(errors).toEqual([])
})

test('SDK model discovery, native history, rename, fork, engine isolation and restart work through Electron', async () => {
  test.setTimeout(90_000)
  await page.getByRole('button', { name: '选择模型' }).click()
  await expect(
    page.getByRole('dialog', { name: '选择模型' }).or(page.locator('.model-picker'))
  ).toBeVisible()
  expect((await state()).models.length).toBeGreaterThan(2)
  await page.keyboard.press('Escape')
  await send('hello fixture')
  await idle()
  await expect(
    page.locator('.assistant-node').getByText('Claude fixture reply.', { exact: true })
  ).toBeVisible()
  await expect(page.locator('.assistant-node')).toHaveCount(1)
  const saved = await state()
  expect(saved.activeSessionPath).toContain(join('data', 'runtimes', 'claude', 'sessions') + sep)
  const reference = JSON.parse(await readFile(saved.activeSessionPath!, 'utf8'))
  expect(reference.nativeSessionId).toBe(saved.sessionId)
  expect(reference).not.toHaveProperty('messages')
  await page.evaluate(
    (snapshot) =>
      window.pi.send({
        type: 'session:rename',
        sessionId: snapshot.sessionId!,
        generation: snapshot.generation,
        name: 'SDK 原生会话'
      }),
    saved
  )
  await expect(page.locator('.conversation-session-title')).toHaveText('SDK 原生会话')
  await page.screenshot({ path: join(screenshots, 'claude-conversation.png') })
  const fork = await page.evaluate(async () => {
    const snapshot = await window.pi.getState()
    return window.pi.send({
      type: 'session:fork',
      sessionId: snapshot.sessionId!,
      generation: snapshot.generation,
      entryId: snapshot.fork!.entryId!
    })
  })
  expect(fork.cancelled).toBe(false)
  expect(fork.snapshot.sessionId).not.toBe(saved.sessionId)
  await selectEngine('Pi')
  expect((await state()).accounts.some((account) => account.id === 'fixture')).toBe(true)
  expect(
    (await state()).accounts.some((account) => account.id === 'anthropic' && account.connected)
  ).toBe(false)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
  await send('Pi fixture')
  await idle()
  await expect(
    page.locator('.assistant-node').getByText('Pi fixture reply.', { exact: true })
  ).toBeVisible()
  const catalog = await page.evaluate(() => window.pi.send({ type: 'project:catalog' }))
  expect(
    catalog.catalog.projects
      .flatMap((item) => item.sessions)
      .some((session) => session.runtimeId === 'claude' && session.path === saved.activeSessionPath)
  ).toBe(true)
  await page.evaluate(
    ({ cwd, path }) =>
      window.pi.send({
        type: 'project:navigate',
        cwd,
        sessionPath: path!,
        sessionId: null,
        generation: 0
      }),
    { cwd: project, path: saved.activeSessionPath }
  )
  expect((await state()).runtime?.id).toBe('claude')
  await app.close()
  await launch()
  await expect.poll(async () => (await state()).sessionId).toBe(saved.sessionId)
  await expect(page.locator('.conversation-session-title')).toHaveText('SDK 原生会话')
  await expect(page.locator('.assistant-node')).toContainText('Claude fixture reply.')
  expect(await readFile(join(root, 'cli-config/bait.txt'), 'utf8')).toBe(
    'User CLI data stays untouched.'
  )
  expect(await readdir(join(root, 'cli-config'))).toEqual(['bait.txt'])
})

test('real SDK write approval can be denied and allowed; native controls hide Pi-only settings', async () => {
  await send('write fixture')
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await page.screenshot({ path: join(screenshots, 'claude-approval.png') })
  await page.getByRole('button', { name: '拒绝', exact: true }).click()
  await idle()
  await expect(readFile(join(project, 'fixture.txt'))).rejects.toThrow()
  await send('write fixture')
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await idle()
  expect(await readFile(join(project, 'fixture.txt'), 'utf8')).toBe('Native SDK wrote this.\n')
  await page.locator('.permission-chip').click()
  await expect(page.getByText('自定义规则', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '添加文本文件' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '赞', exact: true })).toHaveCount(0)
  // Settings list every engine's accounts whichever chat is open, so a Claude chat still
  // sees Pi's endpoints; Claude's own connections are managed in the same page.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('region', { name: '自定义端点' })).toContainText('用于 Claude Code')
  await page.screenshot({ path: join(screenshots, 'claude-settings.png') })
  await expect(page.getByText('导入旧 Pi 历史', { exact: true })).toHaveCount(0)
})

test('native subagents have a shared directory and inspectable transcript without changing parent state', async () => {
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await send('spawn fixture')
  await idle()
  // The background child's result can still bring a follow-up reply; wait until it settles.
  let settled = ''
  await expect
    .poll(
      async () => {
        const nodes = JSON.stringify((await state()).nodes)
        const same = nodes === settled
        settled = nodes
        return same
      },
      { intervals: [1500] }
    )
    .toBe(true)
  await idle()
  const before = await state()
  const child = before.nodes.flatMap((node) =>
    node.type === 'tool' ? (node.subagent?.children ?? []) : []
  )[0]
  expect(child).toBeDefined()
  await page.getByRole('button', { name: '子 Agent 列表', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '子 Agent 列表' })).toBeVisible()
  await expect(page.locator('.subagent-directory-toggle, .workbench-toggle')).toHaveCount(0)
  await page.screenshot({ path: join(screenshots, 'subagent-directory.png') })
  await page
    .getByRole('complementary', { name: '子 Agent 列表' })
    .getByRole('button', { name: `查看子 Agent：${child.title}` })
    .click()
  await expect(
    page.getByRole('complementary', { name: '子 Agent 详情' }).locator('.subagent-transcript')
  ).toContainText('Private child fixture reply.')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page
    .getByRole('radiogroup', { name: '主题' })
    .getByRole('radio', { name: '深色', exact: true })
    .click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: join(screenshots, 'subagent-inspector-dark.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: '子 Agent 详情' })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 740))
  await page.screenshot({ path: join(screenshots, 'subagent-inspector-narrow.png') })
  const after = await state()
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.activeSessionPath).toBe(before.activeSessionPath)
  expect(after.nodes).toEqual(before.nodes)
  expect(
    after.nodes.some(
      (node) => node.type === 'assistant' && node.markdown.includes('Private child fixture reply.')
    )
  ).toBe(false)
  await page.getByRole('button', { name: '关闭子 Agent 详情' }).click()
  await expect(page.getByRole('complementary', { name: '子 Agent 列表' })).toBeVisible()
  await expect(
    page
      .getByRole('complementary', { name: '子 Agent 列表' })
      .getByRole('button', { name: `查看子 Agent：${child.title}` })
  ).toBeFocused()
  await page.getByRole('button', { name: '关闭子 Agent 列表' }).click()
  await expect(page.getByRole('complementary', { name: '子 Agent 列表' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '子 Agent 列表', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '子 Agent 列表', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: '子 Agent 列表' })).toHaveCount(0)
  await app.close()
  await launch()
  await page.getByRole('button', { name: '子 Agent 列表', exact: true }).click()
  await page
    .getByRole('complementary', { name: '子 Agent 列表' })
    .getByRole('button', { name: `查看子 Agent：${child.title}` })
    .click()
  await expect(
    page.getByRole('complementary', { name: '子 Agent 详情' }).locator('.subagent-transcript')
  ).toContainText('Private child fixture reply.')
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('complementary', { name: '子 Agent 详情' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '终端', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('button', { name: '子 Agent 列表', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /搜索文件/ }).click()
  await expect(page.getByRole('complementary', { name: '子 Agent 列表' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '搜索文件名' })).toBeFocused()
})

test('streaming is incremental, Stop preserves the draft and does not replay the prompt', async () => {
  await send('long fixture')
  await expect
    .poll(async () =>
      (await state()).nodes.some((node) => node.type === 'assistant' && node.streaming)
    )
    .toBe(true)
  await page.getByRole('textbox', { name: '任务输入' }).fill('下一条指令保持草稿')
  await expect(page.getByRole('button', { name: '加入发送队列', exact: true })).toBeDisabled()
  await page.screenshot({ path: join(screenshots, 'claude-streaming.png') })
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await idle()
  await expect(page.getByRole('textbox', { name: '任务输入' })).toHaveValue('下一条指令保持草稿')
  const count = fixture.requests.filter((request) => request.path.includes('/messages')).length
  await page.waitForTimeout(500)
  expect(fixture.requests.filter((request) => request.path.includes('/messages'))).toHaveLength(
    count
  )
  expect((await state()).status).toBe('stopped')
})

test('switching to Pi keeps Claude running in the background and preserves both chat drafts', async () => {
  await send('long fixture')
  await expect.poll(async () => (await state()).busy).toBe(true)
  const claude = await state()
  await page.getByRole('textbox', { name: '任务输入' }).fill('Claude 会话的下一条草稿')
  await selectEngine('Pi')
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
  await send('Pi fixture')
  await idle()
  await expect(page.locator('.assistant-node')).toContainText('Pi fixture reply.')
  await page.getByRole('textbox', { name: '任务输入' }).fill('Pi 会话的下一条草稿')
  const pi = await state()
  await page.evaluate(async (workerId) => {
    const current = await window.pi.getState()
    await window.pi.selectSession(workerId, {
      scope: current.desktopScope!,
      sessionId: current.sessionId,
      generation: current.generation
    })
  }, claude.desktopScope!.workerId)
  await expect.poll(async () => (await state()).sessionId).toBe(claude.sessionId)
  await expect(page.getByRole('textbox', { name: '任务输入' })).toHaveValue(
    'Claude 会话的下一条草稿'
  )
  await idle()
  await expect(page.locator('.assistant-node')).toContainText('Claude streaming fixture')
  expect((await state()).status).toBe('idle')
  expect(
    fixture.requests.filter((request) => request.path.split('?')[0].endsWith('/messages'))
  ).toHaveLength(1)
  await page.evaluate(async (workerId) => {
    const current = await window.pi.getState()
    await window.pi.selectSession(workerId, {
      scope: current.desktopScope!,
      sessionId: current.sessionId,
      generation: current.generation
    })
  }, pi.desktopScope!.workerId)
  await expect(page.getByRole('textbox', { name: '任务输入' })).toHaveValue('Pi 会话的下一条草稿')
})
