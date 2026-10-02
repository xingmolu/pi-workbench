import { openWorkbenchTool } from './workbench-helpers'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseTextContext } from '../../src/shared/text-attachments'
import { displayEnv } from './display-env'
let root: string
let project: string
let app: ElectronApplication
let page: Page
const content =
  '\uFEFF# Synthetic text fixture\nexact selected content <script>never execute</script>\n``` /fake-command ```'

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-text-attachments-')))
  project = join(root, 'project')
  for (const name of ['home', 'agent/extensions', 'user-data', 'project'])
    await mkdir(join(root, name), { recursive: true })
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await writeFile(join(root, 'selected.txt'), content)
  await writeFile(join(project, 'workspace.txt'), 'workspace context snapshot')
  await writeFile(join(root, 'empty.txt'), '')
  await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1, 2]))
  await writeFile(
    join(root, 'agent/auth.json'),
    JSON.stringify({ 'text-fixture': { type: 'api_key', key: 'offline-fixture-only' } })
  )
  await writeFile(join(root, 'agent/models.json'), '{"providers":{}}')
  await writeFile(
    join(root, 'agent/settings.json'),
    '{"compaction":{"enabled":false},"retry":{"enabled":false}}'
  )
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(root, 'agent/extensions/text-fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve(aiRoot, pkg.exports['.'].import))};
    import { writeFileSync, existsSync } from 'node:fs';
    export default function(pi) {
      const faux = fauxProvider({ provider:'text-fixture', api:'text-fixture-api', models:[{id:'offline'}], tokensPerSecond:30 });
      pi.registerProvider(faux.provider);
      pi.on('input', async (event) => {
        if (event.text.includes('DELAY_PREFLIGHT')) await new Promise((resolve) => {
          const timer = setInterval(() => { if (existsSync(${JSON.stringify(join(root, 'release'))})) { clearInterval(timer); resolve(); } }, 25);
        });
      });
      faux.setResponses([(context) => {
        writeFileSync(${JSON.stringify(join(root, 'received.json'))}, JSON.stringify(context.messages));
        if (JSON.stringify(context.messages).includes('FAIL_AFTER_ACCEPTANCE')) throw new Error('synthetic model failure after acceptance');
        return fauxAssistantMessage('离线文本上下文已收到。'.repeat(12));
      }]);
    }
  `
  )
  app = await electron.launch({
    args: [resolve('.')],
    cwd: root,
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      PI_CODING_AGENT_DIR: join(root, 'agent')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  const identity = await page.evaluate(() => window.pi.getState())
  // A Host-side selection must unlock the existing composer, not require a new
  // session just to reset its previously unselected account state.
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'text-fixture', modelId: 'offline' })
  )
  await expect(page.getByRole('textbox', { name: '任务输入', exact: true })).toBeEnabled()
  const selected = await page.evaluate(() => window.pi.getState())
  expect(selected.sessionId).toBe(identity.sessionId)
  expect(selected.generation).toBe(identity.generation)
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})
async function select(paths: string[], canceled = false): Promise<void> {
  await app.evaluate(
    ({ dialog }, result) => {
      dialog.showOpenDialog = async () => result
    },
    { canceled, filePaths: paths }
  )
  await page.getByRole('button', { name: '添加文本文件', exact: true }).click()
}

test('picker, Files, cancel, remove and exact snapshot reach Pi and reopen after source deletion', async () => {
  await expect(page.getByRole('button', { name: '添加文本文件', exact: true })).toBeEnabled()
  await select([join(root, 'selected.txt')])
  const chips = page.getByRole('list', { name: '已选择的文本文件' })
  await expect(chips).toContainText('selected.txt')
  await select([], true)
  await expect(chips.locator('li')).toHaveCount(1)
  await select([join(root, 'empty.txt')])
  await expect(chips.locator('li')).toHaveCount(2)
  await page.getByRole('button', { name: '移除 empty.txt', exact: true }).click()
  await expect(chips.locator('li')).toHaveCount(1)
  await openWorkbenchTool(page, '文件')
  const pane = page.getByRole('region', { name: '项目文件' })
  await pane.getByRole('button', { name: 'workspace.txt', exact: true }).click()
  await pane.getByRole('button', { name: '添加到对话', exact: true }).click()
  await expect(chips.locator('li')).toHaveCount(2)
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('请检查这些文本快照')
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({
      path: resolve(`artifacts/e2e/text-attachments${width === 960 ? '-960' : ''}.png`)
    })
  }
  await rm(join(root, 'selected.txt'))
  await writeFile(join(project, 'workspace.txt'), 'changed after staging')
  await draft.press('Enter')
  await expect(chips).toHaveCount(0)
  await expect(draft).toHaveValue('')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  const received = JSON.parse(await readFile(join(root, 'received.json'), 'utf8'))
  const canonical = received.find((m: { role: string }) => m.role === 'user').content[0].text
  expect(parseTextContext(canonical)).toMatchObject({
    text: '请检查这些文本快照',
    files: [
      { name: 'selected.txt', text: content },
      { name: 'workspace.txt', text: 'workspace context snapshot' }
    ]
  })
  const state = await page.evaluate(() => window.pi.getState())
  expect(state.nodes.filter((n) => n.type === 'user')).toHaveLength(1)
  expect(state.nodes.find((n) => n.type === 'user')).toMatchObject({ text: canonical })
  expect(await readFile(state.activeSessionPath!, 'utf8')).toContain('Synthetic text fixture')
  await page.evaluate(
    (path) => window.pi.send({ type: 'session:open', path }),
    state.activeSessionPath!
  )
  const history = page.locator('.user-node')
  await expect(history.locator('details')).toHaveCount(2)
  await history.locator('summary').first().click()
  await expect(history.locator('pre').first()).toHaveText(content)
  await expect(history.locator('script')).toHaveCount(0)
  await expect(page.locator('.conversation-session-title')).toHaveText('请检查这些文本快照')
  await page.screenshot({ path: resolve('artifacts/e2e/text-attachments-history.png') })
})

test('binary/count errors and a real stale snapshot rejection retain composer', async () => {
  await select([join(root, 'selected.txt')])
  await select([join(root, 'binary.txt')])
  await expect(page.locator('.attachment-status')).toContainText('二进制')
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await select(Array(4).fill(join(root, 'empty.txt')))
  await expect(page.locator('.attachment-status')).toContainText('最多添加 4')
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('失败后保留的文字')
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    const scope = {
      projectPath: state.project!.path,
      sessionId: state.sessionId!,
      generation: state.generation
    }
    const staged = await window.pi.textAttachments({ type: 'pick', scope })
    if (staged.type === 'staged')
      await window.pi.textAttachments({ type: 'remove', scope, id: staged.files[0].id })
  })
  await draft.press('Enter')
  await expect(page.locator('.attachment-status')).toContainText('未接收')
  await expect(draft).toHaveValue('失败后保留的文字')
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await page.getByRole('button', { name: '移除 selected.txt', exact: true }).click()
  await expect(page.locator('.attachment-chips')).toHaveCount(0)
  await select([join(root, 'empty.txt')])
  await draft.press('Enter')
  await expect(page.locator('.attachment-chips')).toHaveCount(0)
  await expect(draft).toHaveValue('')
})

test('attachment-only send is accepted and selecting text during streaming preserves Stop', async () => {
  await select([join(root, 'empty.txt')])
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(page.locator('.attachment-chips')).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  await select([join(root, 'selected.txt')])
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
})

test('unknown preflight locks original submission, late query accepts once and preserves newer edits', async () => {
  await select([join(root, 'selected.txt')])
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('DELAY_PREFLIGHT original text')
  await draft.press('Enter')
  await expect(page.locator('.attachment-status')).toContainText('等待 Pi')
  await draft.fill('发送期间的新草稿')
  await expect(page.locator('.attachment-status')).toContainText('结果未知', { timeout: 22000 })
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled()
  await draft.press('Enter')
  await writeFile(join(root, 'release'), 'fixture release')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  await page.getByRole('button', { name: '查询原发送结果', exact: true }).click()
  await expect(page.locator('.attachment-chips')).toHaveCount(0)
  await expect(draft).toHaveValue('发送期间的新草稿')
  await page
    .getByRole('button', { name: '停止当前运行', exact: true })
    .count()
    .then(async (count) => {
      if (count) await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
    })
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  expect(
    (await page.evaluate(() => window.pi.getState())).nodes.filter((n) => n.type === 'user')
  ).toHaveLength(1)
  await select([join(root, 'empty.txt')])
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await expect(page.locator('.attachment-chips')).toContainText('empty.txt')
})

test('late picker result is discarded across session switch and generic prompt bypass is denied', async () => {
  await select([join(root, 'selected.txt')])
  await app.evaluate(
    ({ dialog, ipcMain }, path) => {
      dialog.showOpenDialog = () =>
        new Promise<Electron.OpenDialogReturnValue>((resolve) =>
          ipcMain.once('fixture:release-picker', () =>
            resolve({ canceled: false, filePaths: [path] })
          )
        )
    },
    join(root, 'selected.txt')
  )
  await page.getByRole('button', { name: '添加文本文件', exact: true }).click()
  await page.evaluate(() =>
    window.pi.send({ type: 'session:new', providerId: 'text-fixture', modelId: 'offline' })
  )
  await app.evaluate(({ ipcMain }) => ipcMain.emit('fixture:release-picker'))
  await expect(page.locator('.attachment-chips')).toHaveCount(0)
  await expect(page.locator('.attachment-status')).toContainText('会话已切换')
  const error = await page.evaluate(async () => {
    const state = await window.pi.getState()
    try {
      await window.pi.send({
        type: 'attachment:prompt',
        scope: {
          projectPath: state.project!.path,
          sessionId: state.sessionId!,
          generation: state.generation
        },
        submissionId: crypto.randomUUID(),
        text: 'bypass'
      })
      return null
    } catch {
      return 'denied'
    }
  })
  expect(error).toBe('denied')
})

test('actual isolated Host loss retains unknown submission without resend', async () => {
  await select([join(root, 'selected.txt')])
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('DELAY_PREFLIGHT retained on Host loss')
  await draft.press('Enter')
  await expect(page.locator('.attachment-status')).toContainText('等待 Pi')
  const workerId = (await page.evaluate(() => window.pi.getState())).desktopScope!.workerId
  const pid = await app.evaluate(
    ({ app }, workerId) => app.getAppMetrics().find((m) => m.name === `Pi Session Host ${workerId}`)?.pid, workerId
  )
  expect(pid).toBeTruthy()
  await app.evaluate(({}, pid) => process.kill(pid!, 'SIGKILL'), pid)
  await expect(page.locator('.attachment-status')).toContainText('结果未知')
  await expect(draft).toHaveValue('DELAY_PREFLIGHT retained on Host loss')
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await page.getByRole('button', { name: '查询原发送结果', exact: true }).click()
  await expect(page.locator('.attachment-status')).toContainText('结果未知')
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled()
})

test('real picker displays 1 MiB and 2 MiB limits while preserving the draft and selected snapshots', async () => {
  await writeFile(join(root, 'too-large.txt'), 'x'.repeat(1048577))
  await writeFile(join(root, 'one-mib.txt'), 'x'.repeat(1048576))
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('limit failure retains this draft')
  await select([join(root, 'selected.txt')])
  await select([join(root, 'too-large.txt')])
  await expect(page.locator('.attachment-status')).toContainText('单个文本文件不能超过 1 MiB')
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await select([join(root, 'one-mib.txt'), join(root, 'one-mib.txt')])
  await expect(page.locator('.attachment-status')).toContainText('合计不能超过 2 MiB')
  await expect(page.locator('.attachment-chips li')).toHaveCount(1)
  await expect(draft).toHaveValue('limit failure retains this draft')
})

test('postacceptance offline model failure is visible without retrying or restoring accepted attachments', async () => {
  await select([join(root, 'selected.txt')])
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('FAIL_AFTER_ACCEPTANCE')
  await draft.press('Enter')
  await expect(page.locator('.attachment-status')).toContainText('Pi 已接收')
  await expect(page.locator('.attachment-chips')).toHaveCount(0)
  await expect(draft).toHaveValue('')
  await expect(
    page
      .locator('.error-node, .client-error')
      .filter({ hasText: 'synthetic model failure after acceptance' })
      .first()
  ).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  const state = await page.evaluate(() => window.pi.getState())
  expect(state.nodes.filter((node) => node.type === 'user')).toHaveLength(1)
  await expect(page.locator('.attachment-status')).toContainText('Pi 已接收')
})
