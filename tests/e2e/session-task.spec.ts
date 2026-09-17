import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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
        if (userText.includes('CHILD_TASK')) return fauxAssistantMessage('CHILD_DONE');
        if (!userText.includes('ORCHESTRATE')) return fauxAssistantMessage('UNEXPECTED');
        const results = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'session_task');
        if (results.length === 0) {
          return fauxAssistantMessage(
            fauxToolCall('session_task', {action:'spawn', prompt:'CHILD_TASK'}, {id:'session-task-spawn'}),
            {stopReason:'toolUse'}
          );
        }
        const resultText = textContent(results.at(-1));
        const taskId = resultText.match(/"taskId"\\s*:\\s*"([^"]+)"/)?.[1];
        if (!taskId) return fauxAssistantMessage('PARENT_ERROR_NO_TASK_ID');
        if (results.length === 1) {
          return fauxAssistantMessage(
            fauxToolCall('session_task', {action:'wait', taskId, timeoutMs:45000}, {id:'session-task-wait'}),
            {stopReason:'toolUse'}
          );
        }
        if (results.length === 2) {
          return fauxAssistantMessage(
            fauxToolCall('session_task', {action:'result', taskId}, {id:'session-task-result'}),
            {stopReason:'toolUse'}
          );
        }
        return fauxAssistantMessage('PARENT_DONE ' + resultText);
      };
      faux.setResponses([respond, respond, respond, respond, respond, respond]);
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
  await expect.poll(() => fileExists(join(root, 'fixture-registered')), { timeout: 10000 }).toBe(true)
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await window.pi.getState()).accounts.find((account) => account.id === 'fixture') ?? null
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

test('parent Agent delegates to a background SessionTask and reads its canonical result', async () => {
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
  expect(assistantText).toContain('CHILD_DONE')

  const sessionTaskTools = finished.nodes.filter(
    (node) => node.type === 'tool' && node.name === 'session_task'
  )
  expect(sessionTaskTools).toHaveLength(3)
  expect(sessionTaskTools.every((node) => node.type === 'tool' && node.status === 'success')).toBe(true)

  const sessions = join(root, 'agent/sessions')
  const files = (await readdir(sessions, { recursive: true })).filter((path) => path.endsWith('.jsonl'))
  const histories = await Promise.all(files.map((path) => readFile(join(sessions, path), 'utf8')))
  expect(histories.some((history) => history.includes('CHILD_TASK') && history.includes('CHILD_DONE'))).toBe(true)
  expect(histories.some((history) => history.includes('ORCHESTRATE') && history.includes('PARENT_DONE'))).toBe(true)
  await page.screenshot({ path: resolve('artifacts/e2e/session-task-delegation.png') })
})
