import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { chmod, mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatTextContext, parseTextContext } from '../../src/shared/text-attachments'

let app: ElectronApplication, page: Page, root: string, project: string, sourcePath: string
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-edit-')))
  project = join(root, 'project')
  const agentDir = join(root, 'agent'),
    bucket = join(
      agentDir,
      'sessions',
      `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    )
  for (const dir of [
    project,
    join(root, 'home'),
    join(root, 'user-data'),
    bucket,
    join(agentDir, 'extensions'),
    resolve('artifacts/e2e')
  ])
    await mkdir(dir, { recursive: true })
  const timestamp = '2026-09-11T01:00:00.000Z'
  const entries: object[] = [
    { type: 'session', version: 3, id: 'edit-source', timestamp, cwd: project }
  ]
  const add = (id: string, parentId: string | null, data: object) =>
    entries.push({ id, parentId, timestamp, ...data })
  const answer = (text: string) => ({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'edit-fixture',
      model: 'exact',
      stopReason: 'stop',
      timestamp: Date.parse(timestamp) + 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    }
  })
  add('model', null, { type: 'model_change', provider: 'edit-fixture', modelId: 'exact' })
  add('thinking', 'model', { type: 'thinking_level_change', thinkingLevel: 'off' })
  add('first', 'thinking', {
    type: 'message',
    message: { role: 'user', content: '第一个问题', timestamp: Date.parse(timestamp) + 1 }
  })
  add('first-answer', 'first', answer('第一个回答'))
  add('latest', 'first-answer', {
    type: 'message',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: formatTextContext('最近的问题', [
            { id: 'file', kind: 'text', name: '已删除来源.txt', size: 8, text: 'snapshot' }
          ])
        },
        { type: 'image', mimeType: 'image/png', data: 'YQ==' }
      ],
      timestamp: Date.parse(timestamp) + 3
    }
  })
  add('latest-answer', 'latest', answer('原来的第二个回答'))
  sourcePath = join(bucket, 'source.jsonl')
  await writeFile(sourcePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  await writeFile(join(project, 'side-effect.txt'), 'already executed')
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ 'edit-fixture': { type: 'api_key', key: 'offline-fixture-only' } })
  )
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const publicAI = resolve(
    aiRoot,
    JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8')).exports['.'].import
  )
  await writeFile(
    join(agentDir, 'extensions', 'edit-fixture.ts'),
    `
    import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider: 'edit-fixture', models: [{ id: 'exact' }], tokensPerSecond: 1000 });
      faux.setResponses([() => { appendFileSync(${JSON.stringify(join(root, 'model-calls'))}, '1'); return existsSync(${JSON.stringify(join(root, 'request-tool'))}) ? fauxAssistantMessage([fauxToolCall('edit_fixture_effect', {})], { stopReason: 'toolUse' }) : fauxAssistantMessage('编辑后的离线回答'); }, fauxAssistantMessage('fixture tool finished')]);
      pi.registerProvider(faux.provider);
      pi.registerTool({ name: 'edit_fixture_effect', label: 'Fixture effect', description: 'Isolated test effect', parameters: { type: 'object', properties: {} }, execute: async () => { appendFileSync(${JSON.stringify(join(root, 'tool-calls'))}, '1'); return { content: [{ type: 'text', text: 'fixture done' }], details: {} }; } });
      pi.on('session_before_tree', async () => { while (existsSync(${JSON.stringify(join(root, 'delay'))})) await new Promise(resolve => setTimeout(resolve, 20)); return existsSync(${JSON.stringify(join(root, 'cancel'))}) ? { cancel: true } : existsSync(${JSON.stringify(join(root, 'label'))}) ? { label: 'real extension label' } : undefined; });
      pi.on('input', async () => { if (existsSync(${JSON.stringify(join(root, 'input-delay'))})) writeFileSync(${JSON.stringify(join(root, 'input-entered'))}, '1'); while (existsSync(${JSON.stringify(join(root, 'input-delay'))})) await new Promise(resolve => setTimeout(resolve, 20)); return existsSync(${JSON.stringify(join(root, 'handled'))}) ? { action: 'handled' } : existsSync(${JSON.stringify(join(root, 'transform'))}) ? { action: 'transform', text: '输入扩展转换后的问题' } : { action: 'continue' }; });
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
      PI_DESKTOP_E2E_AGENT_DIR: agentDir,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        try {
          return (await window.pi.getState()).ready
        } catch {
          return false
        }
      })
    )
    .toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await expect(page.locator('.node-flow')).toContainText('最近的问题')
})
test.afterEach(async () => {
  if (sourcePath) await chmod(sourcePath, 0o600).catch(() => {})
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('latest user edit cancel is read-only; explicit send branches in the same file and preserves ordinary draft', async () => {
  const before = await readFile(sourcePath, 'utf8'),
    state = await page.evaluate(() => window.pi.getState())
  const composer = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await composer.fill('普通草稿保留')
  await expect(page.getByRole('button', { name: '编辑问题', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '编辑最近的问题', exact: true })
  await expect(editor).toHaveValue('最近的问题')
  await expect(page.getByRole('list', { name: '保留的附件' })).toContainText('已删除来源.txt')
  await editor.fill('取消的草稿')
  await editor.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('button', { name: '编辑问题', exact: true })).toBeFocused()
  expect(await readFile(sourcePath, 'utf8')).toBe(before)
  expect((await page.evaluate(() => window.pi.getState())).generation).toBe(state.generation)
  await expect(composer).toHaveValue('普通草稿保留')
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await editor.fill('修改后的问题')
  for (const width of [960, 1240, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
      width
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await expect(editor).toBeVisible()
    await expect(page.getByRole('button', { name: '发送编辑', exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(`artifacts/e2e/session-edit-${width}.png`) })
  }
  await page.getByRole('button', { name: '发送编辑', exact: true }).dblclick()
  await expect(page.locator('.node-flow')).toContainText('编辑后的离线回答')
  await expect(composer).toHaveValue('普通草稿保留')
  const after = await page.evaluate(() => window.pi.getState())
  expect(after.sessionId).toBe(state.sessionId)
  expect(after.activeSessionPath).toBe(sourcePath)
  expect(after.generation).toBe(state.generation + 1)
  const entries = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    entries
      .slice(0, before.trim().split('\n').length)
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n'
  ).toBe(before)
  const user = entries.find(
    (e) =>
      e.type === 'message' && e.message.role === 'user' && e.id !== 'first' && e.id !== 'latest'
  )
  expect(user.parentId).toBe('first-answer')
  expect(parseTextContext(user.message.content[0].text)).toMatchObject({
    text: '修改后的问题',
    files: [{ name: '已删除来源.txt', text: 'snapshot' }]
  })
  expect(user.message.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' })
  expect(await readFile(join(project, 'side-effect.txt'), 'utf8')).toBe('already executed')
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await expect(page.locator('.node-flow')).toContainText('修改后的问题')
  await expect(page.locator('.node-flow')).not.toContainText('原来的第二个回答')
})

test('Stop during real input preflight prevents model/tool dispatch and allows a later explicit task', async () => {
  await writeFile(join(root, 'input-delay'), '')
  await writeFile(join(root, 'request-tool'), '')
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await page.getByRole('button', { name: '发送编辑', exact: true }).click()
  await expect.poll(() => readFile(join(root, 'input-entered'), 'utf8').catch(() => '')).toBe('1')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 900))
  await page.screenshot({ path: resolve('artifacts/e2e/session-edit-stopping-960.png') })
  await rm(join(root, 'input-delay'))
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).edit?.pending))
    .toBe(false)
  expect(await readFile(join(root, 'model-calls'), 'utf8').catch(() => '')).toBe('')
  expect(await readFile(join(root, 'tool-calls'), 'utf8').catch(() => '')).toBe('')
  await page.getByRole('button', { name: '关闭并核对', exact: true }).click()
  await rm(join(root, 'request-tool'))
  await page
    .getByRole('textbox', { name: '给 Pi 的任务', exact: true })
    .fill('停止后明确发送的新任务')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(page.locator('.node-flow')).toContainText('编辑后的离线回答')
  expect(await readFile(join(root, 'model-calls'), 'utf8')).toBe('1')
  expect(await readFile(join(root, 'tool-calls'), 'utf8').catch(() => '')).toBe('')
})

test('Stop during a real delayed hook is nonblocking, does not send, and retains ordinary draft', async () => {
  await writeFile(join(root, 'delay'), '')
  const bytes = await readFile(sourcePath, 'utf8')
  await page.getByRole('textbox', { name: '给 Pi 的任务', exact: true }).fill('独立普通草稿')
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await page.getByRole('button', { name: '发送编辑', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled()
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  await rm(join(root, 'delay'))
  await expect(page.getByRole('region', { name: '编辑问题面板' })).toContainText('编辑已取消')
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toHaveValue(
    '独立普通草稿'
  )
})

test('real canonical write failure disconnects unsafe runtime while retaining editor and ordinary draft', async () => {
  const bytes = await readFile(sourcePath, 'utf8')
  await page.getByRole('textbox', { name: '给 Pi 的任务', exact: true }).fill('失败也保留普通草稿')
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await page
    .getByRole('textbox', { name: '编辑最近的问题', exact: true })
    .fill('失败也保留编辑草稿')
  await writeFile(join(root, 'label'), '')
  await chmod(sourcePath, 0o400)
  await page.getByRole('button', { name: '发送编辑', exact: true }).click()
  await expect(page.getByRole('button', { name: '重新连接引擎', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '编辑最近的问题', exact: true })).toHaveValue(
    '失败也保留编辑草稿'
  )
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toHaveValue(
    '失败也保留普通草稿'
  )
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 900))
  await page.screenshot({ path: resolve('artifacts/e2e/session-edit-error-960.png') })
  await expect(page.getByRole('region', { name: '编辑问题面板' })).toContainText(
    '请重新连接引擎后核对当前记录'
  )
  await chmod(sourcePath, 0o600)
  await page.getByRole('button', { name: '重新连接以核对编辑', exact: true }).click()
  await expect(page.getByRole('region', { name: '编辑问题面板' })).toContainText('已重新连接')
  await expect(page.getByRole('textbox', { name: '编辑最近的问题', exact: true })).toHaveValue(
    '失败也保留编辑草稿'
  )
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toHaveValue(
    '失败也保留普通草稿'
  )
  await page.getByRole('button', { name: '关闭并核对', exact: true }).click()
  await expect(page.locator('.node-flow')).toContainText('原来的第二个回答')
})

test('unknown receipt queries a single real delayed input and late acceptance never clears ordinary draft', async () => {
  test.setTimeout(45000)
  await writeFile(join(root, 'input-delay'), '')
  await page
    .getByRole('textbox', { name: '给 Pi 的任务', exact: true })
    .fill('未知时保留的普通草稿')
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await page.getByRole('textbox', { name: '编辑最近的问题', exact: true }).fill('只有一次编辑发送')
  await page.getByRole('button', { name: '发送编辑', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询发送结果', exact: true })).toBeVisible({
    timeout: 20000
  })
  await page.getByRole('button', { name: '查询发送结果', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询发送结果', exact: true })).toBeVisible()
  await rm(join(root, 'input-delay'))
  await expect(page.locator('.node-flow')).toContainText('编辑后的离线回答')
  await page.getByRole('button', { name: '查询发送结果', exact: true }).click()
  await expect(page.getByRole('region', { name: '编辑问题面板' })).toContainText('Pi 已接受')
  const entries = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    entries.filter(
      (e) =>
        e.type === 'message' && e.message.role === 'user' && e.id !== 'first' && e.id !== 'latest'
    )
  ).toHaveLength(1)
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toHaveValue(
    '未知时保留的普通草稿'
  )
})

test('long text and filenames remain usable by keyboard; malformed content preparation is zero-write', async () => {
  const entries = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  entries.find((e) => e.id === 'latest').message.content[0].text = formatTextContext(
    '很长的问题说明。'.repeat(80),
    [
      {
        id: 'file',
        kind: 'text',
        name: '这是一个较长的来源快照文件名称'.repeat(10) + '.txt',
        size: 8,
        text: 'snapshot'
      }
    ]
  )
  await writeFile(sourcePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1240, 900))
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '编辑最近的问题', exact: true })
  await expect(editor).toBeFocused()
  await editor.press('Tab')
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '发送编辑', exact: true })).toBeFocused()
  await page.screenshot({ path: resolve('artifacts/e2e/session-edit-long-1240.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  entries
    .find((e) => e.id === 'latest')
    .message.content.push({ type: 'text', text: 'unsupported second block' })
  const malformed = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(sourcePath, malformed)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂不支持')
  expect(await readFile(sourcePath, 'utf8')).toBe(malformed)
})

test('image-only latest user leaf has an editor and sends once with retained canonical image', async () => {
  const entries = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((e) => e.id !== 'latest-answer')
  entries.find((e) => e.id === 'latest').message.content = [
    { type: 'image', mimeType: 'image/png', data: 'YQ==' }
  ]
  await writeFile(sourcePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '编辑最近的问题', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '发送编辑', exact: true }).click()
  await expect(page.locator('.node-flow')).toContainText('编辑后的离线回答')
  const after = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const user = after.find(
    (e) =>
      e.type === 'message' && e.message.role === 'user' && e.id !== 'first' && e.id !== 'latest'
  )
  expect(user.parentId).toBe('first-answer')
  // Pi prompt normalizes to one leading text block, including empty image-only input.
  expect(user.message.content).toEqual([
    { type: 'text', text: '' },
    { type: 'image', mimeType: 'image/png', data: 'YQ==' }
  ])
})

test('model change invalidates preparation; unavailable historical model permits viewing and cancellation only', async () => {
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '编辑最近的问题', exact: true })).toHaveValue(
    '最近的问题'
  )
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'edit-fixture', modelId: 'exact' })
  )
  await expect(page.getByRole('region', { name: '编辑问题面板' })).toContainText('重新打开编辑确认')
  await expect(page.getByRole('button', { name: '发送编辑', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭并核对', exact: true }).click()
  const entries = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  for (const e of entries) if (e.type === 'model_change') e.modelId = 'missing'
  const bytes = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(sourcePath, bytes)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await page.getByRole('button', { name: '编辑问题', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '编辑最近的问题', exact: true })).toHaveValue(
    '最近的问题'
  )
  await expect(page.getByRole('button', { name: '发送编辑', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
})

for (const mode of ['handled', 'transform'])
  test(`real input hook ${mode} result keeps receipt semantics honest`, async () => {
    await writeFile(join(root, mode), '')
    const before = (await readFile(sourcePath, 'utf8')).trim().split('\n').length
    await page.getByRole('button', { name: '编辑问题', exact: true }).click()
    await page.getByRole('button', { name: '发送编辑', exact: true }).click()
    await expect(page.getByRole('region', { name: '编辑问题面板' })).toContainText('Pi 已接受')
    if (mode === 'transform')
      await expect(page.locator('.node-flow')).toContainText('输入扩展转换后的问题')
    else expect((await readFile(sourcePath, 'utf8')).trim().split('\n')).toHaveLength(before)
  })
