import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentSnapshot } from '../../src/shared/contracts'

let app: ElectronApplication
let page: Page
let root: string
let project: string
type PerfRecord = {
  residentSessions: number
  workers: Array<{ workerId: string; pid: number | null }>
  processes: Array<{ pid: number; coreCpuPercent: number | null; electronCpuPercent: number }>
}
let perfRecords: PerfRecord[]

test.beforeEach(async ({}, testInfo) => {
  const diagnostics =
    testInfo.title === 'opt-in diagnostics correlate resident workers with actual process metrics'
  perfRecords = []
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-multi-session-')))
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
    join(root, 'agent/extensions/fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(resolve(ai, pkg.exports['.'].import))};
    import { existsSync } from 'node:fs';
    export default function(pi) {
      const faux = fauxProvider({ provider: 'fixture', api: 'fixture-api', models: [{id:'offline'}], tokensPerSecond:40, tokenSize:{min:4,max:4} });
      const respond = async (context) => {
        const user = context.messages.filter(m => m.role === 'user').at(-1);
        if (JSON.stringify(user?.content).includes('TOOL_CATALOG')) {
          return fauxAssistantMessage(JSON.stringify({
            registered: pi.getAllTools().map(tool => tool.name),
            active: (context.tools ?? []).map(tool => tool.name)
          }));
        }
        const tag = JSON.stringify(user?.content).includes('TEST_B') ? 'TEST_B' : 'TEST_A';
        if (JSON.stringify(user?.content).includes('OVERLAP')) {
          for (let n = 0; n < 300 && !existsSync(${JSON.stringify(join(root, 'release-overlap'))}); n++) await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (JSON.stringify(user?.content).includes('BROWSER')) {
          if (context.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage(tag + '_DONE');
          for (let n = 0; n < 100 && !existsSync(${JSON.stringify(join(root, 'release-browser'))}); n++) await new Promise(resolve => setTimeout(resolve, 100));
          return fauxAssistantMessage(fauxToolCall('browser', {action:'new_tab'}, {id:'background-browser'}), {stopReason:'toolUse'});
        }
        if (JSON.stringify(user?.content).includes('APPROVAL')) {
          if (context.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage(tag + '_DONE');
          return fauxAssistantMessage(fauxToolCall('bash', {command: 'echo start_' + tag + ' >> lease.log; sleep 2; echo end_' + tag + ' >> lease.log'}, {id:'tool-' + tag}), {stopReason:'toolUse'});
        }
        return fauxAssistantMessage(tag + '_START ' + '并行会话的独立内容。'.repeat(180) + tag + '_DONE');
      };
      faux.setResponses([respond, respond, respond]); pi.registerProvider(faux.provider);
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
      PI_DESKTOP_PERF_LOG: diagnostics ? '1' : '0',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  if (diagnostics) {
    let buffered = ''
    app.process().stdout?.on('data', (chunk) => {
      buffered += String(chunk)
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const start = line.indexOf('[perf] ')
        if (start >= 0) perfRecords.push(JSON.parse(line.slice(start + 7)) as PerfRecord)
      }
    })
  }
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function prompt(text: string): Promise<AgentSnapshot> {
  await page.evaluate(async (text) => {
    const state = await window.pi.getState()
    if (!state.sessionId) throw new Error('Fixture has no session')
    await window.pi.send({
      type: 'prompt:send',
      text,
      sessionId: state.sessionId,
      generation: state.generation
    })
  }, text)
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  return page.evaluate(() => window.pi.getState())
}

async function select(state: AgentSnapshot): Promise<void> {
  if (!state.desktopScope) throw new Error('Missing resident identity')
  await page.evaluate((workerId) => window.pi.selectSession(workerId), state.desktopScope.workerId)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .toBe(state.sessionId)
}

test('only the current Computer Use tool is registered and exposed to the model', async () => {
  await prompt('TOOL_CATALOG')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  const snapshot = await page.evaluate(() => window.pi.getState())
  const assistant = snapshot.nodes.findLast((node) => node.type === 'assistant')
  if (assistant?.type !== 'assistant') throw new Error('Fixture did not return the tool catalog')
  const catalog = JSON.parse(assistant.markdown) as { registered: string[]; active: string[] }
  for (const tools of [catalog.registered, catalog.active]) {
    expect(tools).toContain('computer')
    expect(tools).not.toContain('desktop')
  }
})

test('opt-in diagnostics correlate resident workers with actual process metrics', async () => {
  const snapshot = await page.evaluate(() => window.pi.getState())
  const workerId = snapshot.desktopScope?.workerId
  expect(workerId).toBeTruthy()
  await expect
    .poll(
      () =>
        perfRecords.some((record) => {
          const worker = record.workers.find((entry) => entry.workerId === workerId)
          return (
            !!worker?.pid &&
            record.processes.some(
              (process) => process.pid === worker.pid && process.coreCpuPercent !== null
            )
          )
        }),
      { timeout: 16000 }
    )
    .toBe(true)
  const record = perfRecords.findLast((entry) =>
    entry.workers.some((worker) => worker.workerId === workerId)
  )!
  const worker = record.workers.find((entry) => entry.workerId === workerId)!
  const process = record.processes.find((entry) => entry.pid === worker.pid)!
  const actual = await app.evaluate(
    ({ app }, id) =>
      app
        .getAppMetrics()
        .find(
          (metric) =>
            metric.name === `Pi Session Host ${id}` ||
            metric.serviceName === `Pi Session Host ${id}`
        )?.pid,
    workerId
  )
  expect(worker.pid).toBe(actual)
  expect(record.residentSessions).toBe(record.workers.length)
  expect(Number.isFinite(process.coreCpuPercent)).toBe(true)
  expect(Number.isFinite(process.electronCpuPercent)).toBe(true)
  const serialized = JSON.stringify(record)
  expect(serialized).not.toContain(project)
  expect(serialized).not.toContain('offline-only')
  expect(serialized).not.toContain('"nodes"')
})

test('two real Pi workers overlap, preserve histories and remain independently selectable', async () => {
  test.setTimeout(60000)
  const a = await prompt('TEST_A OVERLAP：独立回答，不要操作文件')
  const newChat = page.getByRole('button', { name: '在 project 中新建会话', exact: true })
  await expect(newChat).toBeEnabled()
  await newChat.click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(a.sessionId)
  const b = await prompt('TEST_B OVERLAP：另一段独立回答，不要操作文件')
  expect(b.activeModel).toBe('offline')
  expect(b.desktopScope?.workerId).not.toBe(a.desktopScope?.workerId)
  await select(a)
  expect((await page.evaluate(() => window.pi.getState())).busy).toBe(true)
  await expect(page.locator('.project-session-row .is-running')).toHaveCount(2)
  await page.screenshot({ path: resolve('artifacts/e2e/multi-session-two-running.png') })
  await writeFile(join(root, 'release-overlap'), 'ready')
  await select(b)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 30000 })
    .toBe(false)
  const finishedB = await page.evaluate(() => window.pi.getState())
  await select(a)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 30000 })
    .toBe(false)
  const finishedA = await page.evaluate(() => window.pi.getState())
  expect(finishedA.activeSessionPath).toBeTruthy()
  expect(finishedB.activeSessionPath).toBeTruthy()
  const aHistory = await readFile(finishedA.activeSessionPath!, 'utf8')
  const bHistory = await readFile(finishedB.activeSessionPath!, 'utf8')
  expect(aHistory).toContain('TEST_A_DONE')
  expect(aHistory).not.toContain('TEST_B')
  expect(bHistory).toContain('TEST_B_DONE')
  expect(bHistory).not.toContain('TEST_A')
  await page.screenshot({ path: resolve('artifacts/e2e/multi-session-completed.png') })
})

test('Stop affects the selected conversation without stopping its running sibling', async () => {
  test.setTimeout(60000)
  const a = await prompt('TEST_A')
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    await window.pi.send({
      type: 'prompt:send',
      text: 'TEST_A_QUEUED',
      sessionId: state.sessionId!,
      generation: state.generation
    })
  })
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).queuedCount))
    .toBe(1)
  await page.getByRole('button', { name: '在 project 中新建会话', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(a.sessionId)
  const b = await prompt('TEST_B')
  expect(b.queuedCount).toBe(0)
  await select(a)
  expect((await page.evaluate(() => window.pi.getState())).queuedCount).toBe(1)
  await page.evaluate(() => window.pi.send({ type: 'queue:clear' }))
  await page.evaluate(() => window.pi.send({ type: 'prompt:abort' }))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await select(b)
  expect((await page.evaluate(() => window.pi.getState())).busy).toBe(true)
  await page.screenshot({ path: resolve('artifacts/e2e/multi-session-independent-stop.png') })
  await page.evaluate(() => window.pi.send({ type: 'prompt:abort' }))
})

test('approvals belong to each conversation and same-project tools execute serially', async () => {
  test.setTimeout(60000)
  const a = await prompt('TEST_A APPROVAL')
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '在 project 中新建会话', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(a.sessionId)
  const b = await prompt('TEST_B APPROVAL')
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await select(a)
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await select(b)
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).nodes.some(
          (node) =>
            node.type === 'tool' &&
            node.status === 'waiting-resource' &&
            node.durationMs === undefined
        )
      )
    )
    .toBe(true)
  await expect(page.locator('.work-summary-trigger').last()).toContainText('等待项目资源')
  await expect(page.locator('.work-summary-trigger').last()).toContainText('正在工作', {
    timeout: 6000
  })
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 20000 })
    .toBe(false)
  await select(a)
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  expect((await readFile(join(project, 'lease.log'), 'utf8')).trim().split('\n')).toEqual([
    'start_TEST_A',
    'end_TEST_A',
    'start_TEST_B',
    'end_TEST_B'
  ])
  await page.screenshot({ path: resolve('artifacts/e2e/multi-session-approvals.png') })
})

test('a crashed foreground does not stop its sibling and the sidebar can select it', async () => {
  test.setTimeout(60000)
  const a = await prompt('TEST_A')
  await page.getByRole('button', { name: '在 project 中新建会话', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(a.sessionId)
  const b = await prompt('TEST_B')
  await select(a)
  const pid = await app.evaluate(
    ({ app }, workerId) =>
      app.getAppMetrics().find((metric) => metric.name === `Pi Session Host ${workerId}`)?.pid,
    a.desktopScope!.workerId
  )
  expect(pid).toBeDefined()
  await app.evaluate(({}, pid) => process.kill(pid!, 'SIGKILL'), pid)
  await expect(page.getByRole('button', { name: '重新连接引擎' })).toBeVisible()
  const sibling = page.locator('.project-session-row').filter({ hasText: 'TEST_B' })
  await expect(sibling).toBeEnabled()
  await sibling.click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .toBe(b.sessionId)
  expect((await page.evaluate(() => window.pi.getState())).busy).toBe(true)
  await expect(page.getByRole('button', { name: '重新连接引擎' })).toHaveCount(0)
  await page.screenshot({ path: resolve('artifacts/e2e/multi-session-crash-isolation.png') })
  await page.evaluate(() => window.pi.send({ type: 'prompt:abort' }))
})

test('background agent browser calls fail without opening or revealing foreground tabs', async () => {
  test.setTimeout(60000)
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  const a = await prompt('TEST_A BROWSER')
  await page.getByRole('button', { name: '在 project 中新建会话', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(a.sessionId)
  const before = await page.evaluate(
    async () => (await window.pi.browser({ type: 'state:get' })).state
  )
  await writeFile(join(root, 'release-browser'), 'ready')
  // Read the originating canonical history without selecting it while its tool executes.
  await expect
    .poll(
      async () => {
        const sessions = join(root, 'agent/sessions')
        const files = (await readdir(sessions, { recursive: true })).filter((path) =>
          path.endsWith('.jsonl')
        )
        const histories = await Promise.all(
          files.map((path) => readFile(join(sessions, path), 'utf8'))
        )
        return histories.find((history) => history.includes(a.sessionId!)) ?? ''
      },
      { timeout: 20000 }
    )
    .toContain('当前会话未选中')
  const after = await page.evaluate(
    async () => (await window.pi.browser({ type: 'state:get' })).state
  )
  expect(after.pages).toEqual(before.pages)
  expect(after.activePageId).toBe(before.activePageId)
  expect(after.visible).toBe(before.visible)
  await select(a)
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
})
