import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'

let app: ElectronApplication,
  page: Page,
  root: string,
  project: string,
  bucket: string,
  sourcePath: string
test.beforeEach(async ({}, testInfo) => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-fork-')))
  project = join(root, 'project')
  const agentDir = join(root, 'agent')
  bucket = join(
    agentDir,
    'sessions',
    `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  await Promise.all([
    mkdir(project),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(bucket, { recursive: true }),
    mkdir(join(agentDir, 'extensions'), { recursive: true }),
    mkdir(resolve('artifacts/e2e'), { recursive: true })
  ])
  const timestamp = '2026-09-01T00:00:00.000Z'
  const entries: object[] = [{ type: 'session', version: 3, id: 'source', timestamp, cwd: project }]
  const entry = (id: string, parentId: string | null, rest: object) =>
    entries.push({ id, parentId, timestamp, ...rest })
  entry('model', null, {
    type: 'model_change',
    provider: 'unavailable-fixture',
    modelId: 'exact-model'
  })
  entry('thinking', 'model', { type: 'thinking_level_change', thinkingLevel: 'off' })
  entry('user', 'thinking', {
    type: 'message',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '保留结构化历史问题' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ],
      timestamp: Date.parse(timestamp) + 1
    }
  })
  const answer = (text: string) => ({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'unavailable-fixture',
      model: 'exact-model',
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
  entry('other', 'user', answer('不属于当前分支'))
  entry(
    'answer',
    'user',
    answer(
      '当前分支回答，代码和表格保持原样。\n\n```ts\nconst preserved = true\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 历史 | 保留 |'
    )
  )
  entry('label', 'answer', { type: 'label', targetId: 'user', label: '保留标签' })
  entry('name', 'label', { type: 'session_info', name: '分叉来源历史' })
  sourcePath = join(bucket, 'source.jsonl')
  await writeFile(sourcePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  await writeFile(join(project, 'side-effect.txt'), 'already executed tool effect')
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const aiPackage = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, aiPackage.exports['.'].import)
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify(
      testInfo.title.includes('unavailable model')
        ? {}
        : { 'unavailable-fixture': { type: 'api_key', key: 'offline-fixture-only' } }
    )
  )
  await writeFile(
    join(agentDir, 'extensions', 'fork-fixture.ts'),
    `
    import { existsSync } from 'node:fs';
    import { fauxProvider } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider: 'unavailable-fixture', models: [{ id: 'exact-model' }] });
      pi.registerProvider(faux.provider);
      pi.registerCommand('fixture-pending', { description: 'Offline pending command', handler: async () => { while (!existsSync(${JSON.stringify(join(root, 'release'))})) await new Promise(resolve => setTimeout(resolve, 20)); } });
      pi.on('session_before_fork', async () => { while (existsSync(${JSON.stringify(join(root, 'delay'))})) await new Promise(resolve => setTimeout(resolve, 20)); return existsSync(${JSON.stringify(join(root, 'cancel'))}) ? { cancel: true } : undefined; });
    }`
  )
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
      PI_DESKTOP_E2E_AGENT_DIR: agentDir,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  // Public extension registration completes during the first runtime binding.
  // Reopen with that registered provider, as in the canonical-history fixture.
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await expect(page.locator('.conversation-session-title')).toHaveText('分叉来源历史')
})
test.afterEach(async () => {
  if (bucket) await chmod(bucket, 0o700).catch(() => {})
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('visible current-leaf fork preserves source, structured child, draft and verified parent', async () => {
  const source = await readFile(sourcePath, 'utf8')
  const before = await page.evaluate(() => window.pi.getState())
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('来源未发送草稿')
  await page.getByRole('button', { name: '分叉为新会话', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '分叉当前会话' })).toContainText(
    '不复制未发送草稿，不撤销文件或终端操作'
  )
  await page.screenshot({ path: resolve('artifacts/e2e/session-fork-confirm.png') })
  await page.getByRole('button', { name: '确认分叉', exact: true }).dblclick()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(before.sessionId)
  const child = await page.evaluate(() => window.pi.getState())
  await expect(page.locator('.session-row.is-active .session-fork-label')).toBeVisible()
  await expect(page.locator('.session-row.is-active .session-fork-label')).toHaveAttribute(
    'aria-label',
    '分叉会话'
  )
  await expect(draft).toHaveValue('')
  expect(child.activeProvider).toBe('unavailable-fixture')
  expect(child.activeModel).toBe('exact-model')
  expect(child.composeBlockReason).toBe(null)
  expect(child.generation).toBe(before.generation + 1)
  expect((await readdir(bucket)).filter((p) => p.endsWith('.jsonl'))).toHaveLength(2)
  const childEntries = (await readFile(child.activeSessionPath!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(childEntries[0].parentSession).toBe(sourcePath)
  expect(JSON.stringify(childEntries)).not.toContain('不属于当前分支')
  expect(childEntries.find((e) => e.id === 'user').message.content[1]).toEqual({
    type: 'image',
    mimeType: 'image/png',
    data: 'aW1hZ2U='
  })
  expect(childEntries.filter((e) => e.type === 'label')).toHaveLength(1)
  expect(await readFile(sourcePath, 'utf8')).toBe(source)
  expect(await readFile(join(project, 'side-effect.txt'), 'utf8')).toBe(
    'already executed tool effect'
  )
  await expect(page.locator('.node-flow')).toContainText('当前分支回答')
  await page.screenshot({ path: resolve('artifacts/e2e/session-fork.png') })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setSize(960, 800)
  })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true)
  await page.screenshot({ path: resolve('artifacts/e2e/session-fork-960.png') })
  await page.getByRole('button', { name: '来源会话', exact: true }).click()
  await expect(draft).toHaveValue('来源未发送草稿')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .toBe('source')
  // A path absent from the same-project SDK list is never offered to the renderer.
  await rm(sourcePath)
  await page.evaluate(
    (path) => window.pi.send({ type: 'session:open', path }),
    child.activeSessionPath!
  )
  await expect(page.getByText('来源会话当前不可用', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '来源会话', exact: true })).toHaveCount(0)
  expect(
    (await page.evaluate(() => window.pi.getState())).sessions.find((s) => s.active)
      ?.parentSessionPath
  ).toBeUndefined()
})

test('real extension cancellation keeps source, draft and generation; stale fork and prompt requests never write', async () => {
  await writeFile(join(root, 'cancel'), '')
  const before = await page.evaluate(() => window.pi.getState())
  const bytes = await readFile(sourcePath, 'utf8')
  await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('取消后保留草稿')
  await page.getByRole('button', { name: '分叉为新会话', exact: true }).click()
  await page.getByRole('button', { name: '确认分叉', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '扩展已取消分叉' })).toBeVisible()
  const after = await page.evaluate(() => window.pi.getState())
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.generation).toBe(before.generation)
  await expect(page.getByRole('textbox', { name: '任务输入', exact: true })).toHaveValue(
    '取消后保留草稿'
  )
  const errors = await page.evaluate(async (state) => {
    const results: string[] = []
    for (const command of [
      {
        type: 'session:fork' as const,
        sessionId: state.sessionId!,
        generation: state.generation + 1,
        entryId: state.fork!.entryId!
      },
      {
        type: 'session:fork' as const,
        sessionId: state.sessionId!,
        generation: state.generation,
        entryId: 'entry:presentation:not-canonical'
      },
      {
        type: 'prompt:send' as const,
        sessionId: 'old-source',
        generation: state.generation,
        text: 'must not send'
      }
    ]) {
      try {
        await window.pi.send(command)
        results.push('unexpected success')
      } catch (e) {
        results.push(String(e))
      }
    }
    return results
  }, before)
  expect(errors[0]).toContain('会话已变化')
  expect(errors[1]).toContain('会话已变化')
  expect(errors[2]).toContain('会话已切换')
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  expect((await readdir(bucket)).filter((p) => p.endsWith('.jsonl'))).toHaveLength(1)
})

test('real child creation permission failure stays truthful about possible child and refreshes actual source state', async () => {
  const before = await page.evaluate(() => window.pi.getState())
  const bytes = await readFile(sourcePath, 'utf8')
  await chmod(bucket, 0o500)
  await page.getByRole('button', { name: '分叉为新会话', exact: true }).click()
  await page.getByRole('button', { name: '确认分叉', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: '可能已创建新会话' })).toBeVisible()
  const after = await page.evaluate(() => window.pi.getState())
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.generation).toBe(before.generation)
  expect(after.sessions.some((s) => s.path === sourcePath)).toBe(true)
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  await expect(page.getByRole('button', { name: '确认分叉', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '关闭并核对', exact: true })).toBeEnabled()
  await page.screenshot({ path: resolve('artifacts/e2e/session-fork-failure.png') })
})

test('unavailable model preserves exact child pin and history while locking send', async () => {
  const before = await page.evaluate(() => window.pi.getState())
  await page.getByRole('button', { name: '分叉为新会话', exact: true }).click()
  await page.getByRole('button', { name: '确认分叉', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe(before.sessionId)
  const child = await page.evaluate(() => window.pi.getState())
  expect(child.activeProvider).toBe('unavailable-fixture')
  expect(child.activeModel).toBe('exact-model')
  expect(child.composeBlockReason).toBe('pinned-model-unavailable')
  await expect(page.getByRole('textbox', { name: '任务输入', exact: true })).toBeDisabled()
  await expect(page.locator('.node-flow')).toContainText('当前分支回答')
})

test('actual pending public command rejects fork before writes and exposes keyboard-readable disabled reason', async () => {
  const before = await page.evaluate(() => window.pi.getState())
  const bytes = await readFile(sourcePath, 'utf8')
  await page.evaluate(
    async (state) =>
      window.pi.send({
        type: 'prompt:send',
        text: '/fixture-pending',
        sessionId: state.sessionId!,
        generation: state.generation
      }),
    before
  )
  await expect(page.getByRole('button', { name: '分叉为新会话', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  await expect(
    page.getByRole('button', { name: '分叉为新会话', exact: true })
  ).toHaveAccessibleDescription('当前会话正在运行或等待处理，暂时不能分叉')
  const result = await page.evaluate(async (state) => {
    try {
      await window.pi.send({
        type: 'session:fork',
        sessionId: state.sessionId!,
        generation: state.generation,
        entryId: state.fork!.entryId!
      })
      return 'unexpected success'
    } catch (e) {
      return String(e)
    }
  }, before)
  expect(result).toContain('暂时不能分叉')
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  expect((await readdir(bucket)).filter((p) => p.endsWith('.jsonl'))).toHaveLength(1)
  await writeFile(join(root, 'release'), '')
  await expect(page.getByRole('button', { name: '分叉为新会话', exact: true })).toHaveAttribute(
    'aria-disabled',
    'false'
  )
})

test('pending fork prevents composer submission and rejects an old queued IPC prompt after child activation', async () => {
  const before = await page.evaluate(() => window.pi.getState())
  await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('旧会话草稿不发送')
  await writeFile(join(root, 'delay'), '')
  await page.getByRole('button', { name: '分叉为新会话', exact: true }).click()
  await page.getByRole('button', { name: '确认分叉', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在分叉…', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '任务输入', exact: true }).press('Enter')
  const stale = page.evaluate(async (state) => {
    try {
      await window.pi.send({
        type: 'prompt:send',
        sessionId: state.sessionId!,
        generation: state.generation,
        text: '/fixture-pending'
      })
      return 'unexpected success'
    } catch (e) {
      return String(e)
    }
  }, before)
  await rm(join(root, 'delay'))
  expect(await stale).toContain('会话已改变，旧操作已取消')
  await expect(page.getByRole('textbox', { name: '任务输入', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '来源会话', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '任务输入', exact: true })).toHaveValue(
    '旧会话草稿不发送'
  )
})

test('UI-only delayed fork reply cannot close a newer generation form or overwrite its snapshot', async () => {
  const source = await page.evaluate(() => window.pi.getState())
  await app.evaluate(({ ipcMain }, state) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle(
      'pi:command',
      () =>
        new Promise((resolve) => {
          ipcMain.once('fork-fixture:reply', () =>
            resolve({
              kind: 'session-fork',
              cancelled: false,
              snapshot: { ...state, sessionId: 'delayed-child', generation: state.generation + 1 }
            })
          )
        })
    )
  }, source)
  await page.getByRole('button', { name: '分叉为新会话', exact: true }).click()
  await page.getByRole('button', { name: '确认分叉', exact: true }).dblclick()
  expect(await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('fork-fixture:reply'))).toBe(1)
  await app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
      type: 'event',
      event: 'snapshot',
      data: { ...state, sessionId: 'newer-session', generation: state.generation + 2 }
    })
  }, source)
  await expect(page.getByRole('dialog', { name: '分叉当前会话' })).toHaveCount(0)
  await page.getByRole('button', { name: '重命名会话', exact: true }).click()
  const name = page.getByRole('textbox', { name: '会话名称', exact: true })
  await name.fill('新会话自己的表单')
  await app.evaluate(({ ipcMain }) => ipcMain.emit('fork-fixture:reply'))
  await expect(page.getByRole('button', { name: '分叉为新会话', exact: true })).toHaveAttribute(
    'aria-disabled',
    'false'
  )
  await expect(name).toHaveValue('新会话自己的表单')
  await expect(page.locator('.session-rename-error')).toHaveCount(0)
  expect((await readdir(bucket)).filter((p) => p.endsWith('.jsonl'))).toHaveLength(1)
})
