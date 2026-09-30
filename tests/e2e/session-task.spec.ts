import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication
let page: Page
let root: string
let project: string

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-task-e2e-')))
  project = join(root, 'project')
  for (const directory of ['home', 'agent/extensions', 'data', 'project'])
    await mkdir(join(root, directory), { recursive: true })
  await mkdir(resolve('artifacts/e2e'), { recursive: true })

  const ai = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(ai, 'package.json'), 'utf8'))
  await writeFile(
    join(root, 'agent/auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(root, 'agent/extensions/session-task-fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(resolve(ai, pkg.exports['.'].import))};
    import { writeFileSync } from 'node:fs';
    const entered = ${JSON.stringify(join(root, 'fixture-entered'))};
    const registered = ${JSON.stringify(join(root, 'fixture-registered'))};
    export default function(pi) {
      writeFileSync(entered, 'entered');
      const faux = fauxProvider({ provider: 'fixture', api: 'fixture-api', models: [{id:'offline'}], tokensPerSecond:1000, tokenSize:{min:4,max:4} });
      const textContent = (message) => Array.isArray(message?.content)
        ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('\\n')
        : String(message?.content ?? '');
      const respond = async (context) => {
        const user = context.messages.filter(message => message.role === 'user').at(-1);
        const userText = JSON.stringify(user?.content ?? '');
        if (userText.includes('CHILD_TASK_SLOW')) {
          const tools = context.messages.filter(message => message.role === 'toolResult');
          return tools.length ? fauxAssistantMessage('SLOW_DONE') : fauxAssistantMessage(fauxToolCall('bash', {command:'sleep 20'}, {id:'slow-sleep'}), {stopReason:'toolUse'});
        }
        if (userText.includes('CANCEL_ORCHESTRATE')) {
          const tools = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'session_task');
          return tools.length ? fauxAssistantMessage('PARENT_CONTINUES') : fauxAssistantMessage(fauxToolCall('session_task', {action:'delegate', tasks:['CHILD_TASK_SLOW_A','CHILD_TASK_SLOW_B']}, {id:'slow-delegate'}), {stopReason:'toolUse'});
        }
        if (userText.includes('CHILD_TASK_A')) return fauxAssistantMessage('CHILD_DONE_A');
        if (userText.includes('CHILD_TASK_B')) return fauxAssistantMessage('CHILD_DONE_B');
        if (!userText.includes('ORCHESTRATE')) return fauxAssistantMessage('UNEXPECTED');
        const results = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'session_task');
        if (results.length === 0) {
          return fauxAssistantMessage(
            fauxToolCall('session_task', {action:'delegate', tasks:['CHILD_TASK_A','CHILD_TASK_B']}, {id:'session-task-delegate'}),
            {stopReason:'toolUse'}
          );
        }
        const resultText = textContent(results.at(-1));
        if (results.length === 1) {
          if (!resultText.includes('spawnedTaskIds')) return fauxAssistantMessage('PARENT_ERROR_NO_DELEGATION');
          return fauxAssistantMessage(
            fauxToolCall('session_task', {action:'supervise', mode:'all', timeoutMs:45000}, {id:'session-task-supervise'}),
            {stopReason:'toolUse'}
          );
        }
        if (results.length === 2) {
          return fauxAssistantMessage(
            fauxToolCall('session_task', {action:'collect'}, {id:'session-task-collect'}),
            {stopReason:'toolUse'}
          );
        }
        return fauxAssistantMessage('PARENT_DONE ' + resultText);
      };
      faux.setResponses([respond, respond, respond, respond, respond, respond, respond, respond, respond, respond]);
      pi.registerProvider(faux.provider);
      writeFileSync(registered, 'registered');
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
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
      ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      ...(process.env.DBUS_SESSION_BUS_ADDRESS
        ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
        : {}),
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)

  await expect.poll(() => fileExists(join(root, 'fixture-entered')), { timeout: 10000 }).toBe(true)
  await expect
    .poll(() => fileExists(join(root, 'fixture-registered')), { timeout: 10000 })
    .toBe(true)
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (await window.pi.getState()).accounts.find((account) => account.id === 'fixture') ??
            null
        ),
      { timeout: 10000 }
    )
    .toMatchObject({ id: 'fixture', connected: true })
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('parent Agent batch delegates, supervises and collects two background results', async () => {
  test.setTimeout(90000)
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    if (!state.sessionId) throw new Error('Fixture has no session')
    await window.pi.send({
      type: 'prompt:send',
      text: 'ORCHESTRATE',
      sessionId: state.sessionId,
      generation: state.generation
    })
  })
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 60000 })
    .toBe(false)

  const finished = await page.evaluate(() => window.pi.getState())
  const assistantText = finished.nodes
    .filter((node) => node.type === 'assistant')
    .map((node) => (node.type === 'assistant' ? node.markdown : ''))
    .join('\n')
  expect(assistantText).toContain('PARENT_DONE')
  expect(assistantText).toContain('CHILD_DONE_A')
  expect(assistantText).toContain('CHILD_DONE_B')
  expect(assistantText).toContain('readyTaskIds')

  const sessionTaskTools = finished.nodes.filter(
    (node) => node.type === 'tool' && node.name === 'session_task'
  )
  expect(sessionTaskTools).toHaveLength(3)
  expect(sessionTaskTools.every((node) => node.type === 'tool' && node.status === 'success')).toBe(
    true
  )

  const backgroundRows = page.locator('.project-session-row').filter({ hasText: '后台 Agent' })
  await expect(backgroundRows).toHaveCount(2)
  await expect(backgroundRows.nth(0)).toContainText('CHILD_TASK_A')
  await expect(backgroundRows.nth(1)).toContainText('CHILD_TASK_B')
  await expect(page.locator('.project-session-row.is-active')).not.toContainText('后台 Agent')

  const sessions = join(root, 'agent/sessions')
  const files = (await readdir(sessions, { recursive: true })).filter((path) =>
    path.endsWith('.jsonl')
  )
  const histories = await Promise.all(files.map((path) => readFile(join(sessions, path), 'utf8')))
  expect(
    histories.some(
      (history) => history.includes('CHILD_TASK_A') && history.includes('CHILD_DONE_A')
    )
  ).toBe(true)
  expect(
    histories.some(
      (history) => history.includes('CHILD_TASK_B') && history.includes('CHILD_DONE_B')
    )
  ).toBe(true)
  expect(
    histories.some((history) => history.includes('ORCHESTRATE') && history.includes('PARENT_DONE'))
  ).toBe(true)
  const collaboration = page.getByRole('region', { name: '子 Agent 协作' }).first()
  await expect(collaboration.locator('.subagent-summary')).toHaveCount(2)
  await expect(collaboration.locator('.subagent-raw')).toHaveCount(0)
  await collaboration
    .getByRole('button', { name: '查看子 Agent：CHILD_TASK_A', exact: true })
    .click()
  const inspector = page.getByRole('complementary', { name: '子 Agent 详情' })
  await expect(inspector).toBeVisible()
  await expect(inspector.locator('.subagent-reply')).toContainText('CHILD_DONE_A')
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(finished.sessionId)
  await page.screenshot({ path: resolve('artifacts/e2e/session-task-subagent.png') })
  // Clicking another summary changes only the inspector.
  await collaboration
    .getByRole('button', { name: '查看子 Agent：CHILD_TASK_B', exact: true })
    .click()
  await expect(inspector.locator('.subagent-reply')).toContainText('CHILD_DONE_B')
  await inspector.getByRole('button', { name: '关闭子 Agent 详情' }).click()
  await expect(inspector).toHaveCount(0)
  // Reopening from disk retains structured task/result cards without a live relationship.
  await app.close()
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
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate(
    async ({ cwd, path }) => {
      const state = await window.pi.getState()
      return window.pi.send({
        type: 'project:navigate',
        cwd,
        sessionPath: path,
        sessionId: state.sessionId,
        generation: state.generation
      })
    },
    { cwd: project, path: finished.activeSessionPath! }
  )
  await expect(page.locator('.subagent-list')).toContainText('CHILD_TASK_A')
  await page.getByRole('button', { name: '查看子 Agent：CHILD_TASK_A', exact: true }).click()
  await expect(
    page.getByRole('complementary', { name: '子 Agent 详情' }).locator('.subagent-reply')
  ).toContainText('CHILD_DONE_A')
  await expect(page.getByRole('button', { name: '停止此子 Agent', exact: true })).toHaveCount(0)
})

test('stopping one subagent in the side pane preserves its sibling and the parent', async () => {
  await page.evaluate(async () => {
    await window.pi.send({ type: 'permission:set', mode: 'open' })
    const state = await window.pi.getState()
    await window.pi.send({
      type: 'prompt:send',
      text: 'CANCEL_ORCHESTRATE',
      sessionId: state.sessionId!,
      generation: state.generation
    })
  })
  const summaries = page.locator('.subagent-summary')
  await expect(summaries).toHaveCount(2)
  await expect(summaries.first()).toContainText('sleep 20')
  await summaries.first().click()
  const inspector = page.getByRole('complementary', { name: '子 Agent 详情' })
  await expect(inspector.locator('.subagent-transcript-tool')).toContainText('sleep 20')
  await page.screenshot({ path: resolve('artifacts/e2e/session-task-subagent-running.png') })
  await inspector.getByRole('button', { name: '停止此子 Agent', exact: true }).click()
  await expect(summaries.first()).toContainText('已停止')
  await expect(summaries.nth(1)).toContainText('运行中')
  const parent = await page.evaluate(() => window.pi.getState())
  expect(
    parent.nodes.some(
      (node) => node.type === 'assistant' && node.markdown.includes('PARENT_CONTINUES')
    )
  ).toBe(true)
  expect(parent.busy).toBe(false)
  const taskId = await summaries.nth(1).getAttribute('data-subagent-id')
  const rejected = await page.evaluate(
    async ({ taskId, sessionId, generation }) => {
      try {
        await window.pi.send({
          type: 'session-task:cancel',
          taskId: taskId!,
          sessionId: sessionId!,
          generation: generation + 1
        })
        return false
      } catch {
        return true
      }
    },
    { taskId, sessionId: parent.sessionId, generation: parent.generation }
  )
  expect(rejected).toBe(true)
  await summaries.nth(1).click()
  await inspector.getByRole('button', { name: '停止此子 Agent', exact: true }).click()
  await expect(summaries.nth(1)).toContainText('已停止')
})

test('child approvals stay reachable from the side pane without changing parent selection during inspection', async () => {
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    await window.pi.send({
      type: 'prompt:send',
      text: 'CANCEL_ORCHESTRATE',
      sessionId: state.sessionId!,
      generation: state.generation
    })
  })
  const summaries = page.locator('.subagent-summary')
  await expect(summaries).toHaveCount(2)
  await expect(summaries.first()).toContainText('等待确认')
  const parent = await page.evaluate(() => window.pi.getState())
  await summaries.first().click()
  const inspector = page.getByRole('complementary', { name: '子 Agent 详情' })
  await expect(inspector.getByRole('button', { name: /需要确认操作/ })).toBeVisible()
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(parent.sessionId)
  await inspector.getByRole('button', { name: /需要确认操作/ }).click()
  await expect(page.locator('[data-approval-id]')).toBeVisible()
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await page.locator('.subagent-parent-link').click()
  await summaries.first().click()
  await inspector.getByRole('button', { name: '停止此子 Agent', exact: true }).click()
  await expect(summaries.first()).toContainText('已停止')
  await expect(summaries.nth(1)).toContainText('等待确认')
  await summaries.nth(1).click()
  await inspector.getByRole('button', { name: '停止此子 Agent', exact: true }).click()
  await expect(summaries.nth(1)).toContainText('已停止')
})
