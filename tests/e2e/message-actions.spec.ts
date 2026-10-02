import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
      content: [
        { type: 'text', text },
        ...(text.startsWith('当前分支') ? [{ type: 'text', text: '同一回复的第二个文本块' }] : [])
      ],
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
  entry('later-model', 'label', {
    type: 'model_change',
    provider: 'unavailable-fixture',
    modelId: 'later-model'
  })
  entry('later-user', 'later-model', {
    type: 'message',
    message: { role: 'user', content: '后续问题不可进入早期分叉', timestamp: 4 }
  })
  entry('later-answer', 'later-user', answer('后续回答'))
  entry('final-model', 'later-answer', {
    type: 'model_change',
    provider: 'unavailable-fixture',
    modelId: 'later-model'
  })
  entry('name', 'final-model', { type: 'session_info', name: '分叉来源历史' })
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
      const faux = fauxProvider({ provider: 'unavailable-fixture', models: [{ id: 'exact-model' }, { id: 'later-model' }] });
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

test('message icons copy actual text, persist exclusive local feedback and fork the selected answer boundary', async () => {
  const first = page.locator('.assistant-node').nth(1)
  await expect(page.locator('.assistant-node').first().locator('.message-actions')).toHaveCount(0)
  await expect(first.getByRole('button', { name: '赞', exact: true })).toBeVisible()
  const copy = page.getByRole('button', { name: '复制问题', exact: true }).first()
  await copy.click()
  await expect(page.getByRole('status', { name: '问题复制结果' }).first()).toHaveText(
    '问题文本已复制'
  )
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('保留结构化历史问题')
  await first.getByRole('button', { name: '复制回复', exact: true }).click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('同一回复的第二个文本块')
  await page.getByRole('button', { name: '复制代码', exact: true }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('const preserved = true')
  await first.getByRole('button', { name: '赞', exact: true }).focus()
  await page.mouse.move(5,5)
  await expect(first.getByRole('tooltip', { name: '仅本地记录，不发送给模型服务商' })).toBeVisible()
  await first.getByRole('button', { name: '赞', exact: true }).click()
  await expect(first.getByRole('button', { name: '赞', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.assistant-node').first().locator('.message-actions')).toHaveCount(0)
  await first.getByRole('button', { name: '踩', exact: true }).click()
  await expect(first.getByRole('button', { name: '赞', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await expect(first.getByRole('button', { name: '踩', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), sourcePath)
  await expect(first.getByRole('button', { name: '踩', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await first.getByRole('button', { name: '踩', exact: true }).click()
  await expect(first.getByRole('button', { name: '踩', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  const entries = (await readFile(sourcePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    entries.filter((e) => e.customType === 'pi-desktop:message-feedback').map((e) => e.data)
  ).toEqual([
    { entryId: 'answer', value: 'up' },
    { entryId: 'answer', value: 'down' },
    { entryId: 'answer', value: null }
  ])
  for (const width of [960, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
      width
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await first.scrollIntoViewIfNeeded()
    await page.mouse.move(5,5)
    await first.getByRole('button', { name: '复制回复', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(first.getByRole('button', {name:'赞',exact:true})).toBeFocused()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const path = resolve('artifacts/e2e/message-actions-' + width + '.png')
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64')
    )
    await writeFile(path, Buffer.from(png, 'base64'))
  }
  const before = await readFile(sourcePath, 'utf8')
  expect((await page.evaluate(() => window.pi.getState())).activeModel).toBe('later-model')
  await first.getByRole('button', { name: '从此回复分叉', exact: true }).click()
  await page.getByRole('button', { name: '确认分叉', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .not.toBe('source')
  const child = await page.evaluate(() => window.pi.getState())
  expect(child.activeModel).toBe('exact-model')
  expect(JSON.stringify(child.nodes)).not.toContain('后续问题')
  expect(JSON.stringify(child.nodes)).not.toContain('后续回答')
  const bytes = await readFile(child.activeSessionPath!, 'utf8')
  expect(bytes).toContain('aW1hZ2U=')
  expect(bytes).not.toContain('later-model')
  expect(await readFile(sourcePath, 'utf8')).toBe(before)
})

test('feedback write failure never shows success and requires rereading after reconnect', async () => {
  const before = await readFile(sourcePath, 'utf8')
  await chmod(sourcePath, 0o400)
  await page
    .locator('.assistant-node')
    .nth(1)
    .getByRole('button', { name: '赞', exact: true })
    .click()
  await expect(
    page.locator('.assistant-node').nth(1).getByRole('button', { name: '赞', exact: true })
  ).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: '重新连接引擎', exact: true })).toBeVisible()
  expect(await readFile(sourcePath, 'utf8')).toBe(before)
  await chmod(sourcePath, 0o600)
})

test('uncertain transport result locks the canonical reply action strip; later generations stay clean', async () => {
  const source = await page.evaluate(() => window.pi.getState())
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle(
      'pi:command',
      () =>
        new Promise((_resolve, reject) => {
          ipcMain.once('feedback-fixture:reject', () =>
            reject(new Error('transport result unknown'))
          )
        })
    )
  })
  const first = page
    .locator('.assistant-node')
    .nth(1)
    .getByRole('button', { name: '赞', exact: true })
  const earlierBlock = page.locator('.assistant-node').first()
  await first.click()
  await expect(first).toHaveAttribute('aria-disabled', 'true')
  await expect(earlierBlock.locator('.message-actions')).toHaveCount(0)
  await app.evaluate(({ ipcMain }) => ipcMain.emit('feedback-fixture:reject'))
  await expect(page.locator('.assistant-node').nth(1).getByRole('alert')).toContainText(
    '不要直接重试'
  )
  await expect(first).toHaveAttribute('aria-disabled', 'true')
  expect(
    await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('feedback-fixture:reject'))
  ).toBe(0)
  await app.evaluate(
    ({ BrowserWindow }, state) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
        type: 'event',
        event: 'snapshot',
        data: { ...state, generation: state.generation + 1, sessionId: 'next-session' }
      }),
    source
  )
  await expect(first).toHaveAttribute('aria-disabled', 'false')
  await first.click()
  await app.evaluate(
    ({ BrowserWindow }, state) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
        type: 'event',
        event: 'snapshot',
        data: { ...state, generation: state.generation + 2, sessionId: 'newest-session' }
      }),
    source
  )
  await app.evaluate(({ ipcMain }) => ipcMain.emit('feedback-fixture:reject'))
  await expect(first).toHaveAttribute('aria-disabled', 'false')
  await expect(page.locator('.message-action-result[role="alert"]')).toHaveCount(0)
  await expect(first).toHaveAttribute('aria-pressed', 'false')
})

for (const outcome of ['cancellation', 'rejection'] as const)
test(`same-session reselection and generation changes revoke message fork confirmation and ignore its late ${outcome}`, async () => {
  const trigger = page.locator('.assistant-node').nth(1).getByRole('button', {name:'从此回复分叉',exact:true})
  await trigger.click()
  const before = await page.evaluate(()=>window.pi.getState())
  await page.evaluate(path=>window.pi.send({type:'session:open',path}),sourcePath)
  await expect(page.getByRole('dialog',{name:'分叉当前会话'})).toHaveCount(0)
  const source=await page.evaluate(()=>window.pi.getState())
  expect(source.sessionId).toBe(before.sessionId)
  expect(source.generation).toBe(before.generation)
  expect(source.desktopScope!.selectionEpoch).toBeGreaterThan(before.desktopScope!.selectionEpoch)
  await app.evaluate(({ipcMain},{state,outcome})=>{
    ipcMain.removeHandler('pi:command')
    ipcMain.handle('pi:command',()=>new Promise((resolve,reject)=>ipcMain.once('message-fork:reply',()=>outcome==='rejection'?reject(new Error('旧代际分叉失败，不应污染新确认')):resolve({kind:'session-fork',cancelled:true,snapshot:state}))))
  },{state:source,outcome})
  await trigger.click()
  await page.getByRole('button',{name:'确认分叉',exact:true}).click()
  await app.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event',{type:'event',event:'snapshot',data:{...state,generation:state.generation+1}}),source)
  await expect(page.getByRole('dialog',{name:'分叉当前会话'})).toHaveCount(0)
  await app.evaluate(({ipcMain})=>ipcMain.emit('message-fork:reply'))
  await expect(trigger).toHaveAttribute('aria-disabled','false')
  await trigger.click()
  await expect(page.getByRole('dialog',{name:'分叉当前会话'})).toBeVisible()
  await expect(page.getByText('扩展已取消分叉，当前会话和草稿保留。')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'确认分叉',exact:true})).toBeEnabled()
  await expect(page.locator('.client-error')).toHaveCount(0)
  await expect(page.locator('.session-rename-error')).toHaveCount(0)
})

test('table preview exposes a keyboard tooltip and restores focus after closing', async () => {
  const preview=page.getByRole('button',{name:'预览表格',exact:true})
  await preview.focus()
  await page.mouse.move(5,5)
  await expect(page.getByRole('tooltip',{name:'预览表格',exact:true})).toBeVisible()
  await preview.press('Enter')
  await expect(page.getByRole('region',{name:'表格只读预览'})).toBeFocused()
  await page.getByRole('button',{name:'关闭预览',exact:true}).click()
  await expect(preview).toBeFocused()
})

test('busy public SDK command rejects local feedback without appending', async () => {
  const source = await page.evaluate(() => window.pi.getState())
  const before = await readFile(sourcePath, 'utf8')
  await page.evaluate(
    (s) =>
      window.pi.send({
        type: 'prompt:send',
        sessionId: s.sessionId!,
        generation: s.generation,
        text: '/fixture-pending'
      }),
    source
  )
  await expect(
    page.locator('.assistant-node').nth(1).getByRole('button', { name: '赞', exact: true })
  ).toHaveAttribute('aria-disabled', 'true')
  const error = await page.evaluate(async (s) => {
    try {
      await window.pi.send({
        type: 'message:feedback',
        sessionId: s.sessionId!,
        generation: s.generation,
        entryId: 'answer',
        value: 'up'
      })
      return 'unexpected success'
    } catch (e) {
      return String(e)
    }
  }, source)
  expect(error).toContain('正在运行')
  expect(await readFile(sourcePath, 'utf8')).toBe(before)
  await writeFile(join(root, 'release'), '')
})
