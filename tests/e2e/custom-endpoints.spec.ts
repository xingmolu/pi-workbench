import { createServer } from 'node:http'
import { openWorkbenchTool } from './workbench-helpers'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PiDesktopAPI } from '../../src/shared/contracts'
import { displayEnv } from './display-env'

declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}
let app: ElectronApplication
let page: Page
let root: string
let agentDir: string
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-custom-endpoints-')))
  agentDir = join(root, 'agent')
  await Promise.all(['home', 'agent', 'user-data', 'project'].map((p) => mkdir(join(root, p))))
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'custom-existing': {
          name: '未登录端点',
          api: 'openai-completions',
          baseUrl: 'https://example.invalid/v1',
          models: [{ id: 'old-model' }]
        }
      }
    })
  )
  await mkdir(join(agentDir, 'extensions'))
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const aiPackage = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, aiPackage.exports['.'].import)
  await writeFile(
    join(agentDir, 'extensions', 'endpoint-fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({provider:'endpoint-faux',api:'endpoint-faux-api',models:[{id:'fixture'}],tokensPerSecond:20,tokenSize:{min:1,max:1}});
      pi.registerProvider(faux.provider);
      pi.registerCommand('fixture-endpoint-stream', {description:'Offline fixture response',handler:async()=>{faux.setResponses([fauxAssistantMessage('离线流式输出。'.repeat(20))]);}});
      pi.registerProvider('endpoint-oauth', {baseUrl:'https://example.invalid',api:'openai-completions',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024}],oauth:{name:'Offline OAuth',async login(callbacks){await callbacks.onPrompt({message:'Fixture OAuth gate'});return {access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000};},async refreshToken(c){return c},getApiKey(c){return c.access}}});
    }
  `
  )
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ 'endpoint-faux': { type: 'api_key', key: 'fixture-only' } })
  )
  await launchFixture()
})

async function launchFixture(): Promise<void> {
  app = await electron.launch({
    args: [resolve('.')],
    cwd: join(root, 'project'),
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
  await page.getByRole('button', { name: '设置', exact: true }).click()
}
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('settings modal traps focus and preserves sidebar, workbench and conversation draft', async () => {
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'endpoint-faux', modelId: 'fixture' })
  )
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('保留这份未发送草稿')
  const sidebarWidth = await page
    .locator('.sidebar')
    .evaluate((el) => el.getBoundingClientRect().width)
  const opener = page.getByRole('button', { name: '设置', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Meta+b')
  expect(await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBe(
    sidebarWidth
  )
  expect(
    await page
      .locator('.conversation')
      .evaluate((el) => el.closest('[aria-hidden="true"]') !== null)
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect(draft).toHaveValue('保留这份未发送草稿')
  await expect(page.locator('.workbench.is-collapsed')).toBeHidden()
  await openWorkbenchTool(page, '浏览器')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.pi.browser({ type: 'state:get' })).state.visible)
    )
    .toBe(true)
  const browserBefore = await page.evaluate(
    async () => (await window.pi.browser({ type: 'state:get' })).state
  )
  await opener.click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.pi.browser({ type: 'state:get' })).state.visible)
    )
    .toBe(false)
  await page.keyboard.press('Escape')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.pi.browser({ type: 'state:get' })).state.visible)
    )
    .toBe(true)
  const browserAfter = await page.evaluate(
    async () => (await window.pi.browser({ type: 'state:get' })).state
  )
  expect(browserAfter.activePageId).toBe(browserBefore.activePageId)
  expect(browserAfter.pages.map(({ id }) => id)).toEqual(browserBefore.pages.map(({ id }) => id))
  await expect(draft).toHaveValue('保留这份未发送草稿')
  await opener.click()
  await page.getByRole('button', { name: 'MCP 服务器', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '引擎与账号', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.screenshot({ path: resolve('artifacts/e2e/settings-modal-1440.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
  await page.screenshot({ path: resolve('artifacts/e2e/settings-modal-960.png') })
  await page.getByRole('button', { name: '关闭设置' }).click()
  await expect(opener).toBeFocused()
})

test('creates all three protocols through canonical Pi files without selecting a provider', async () => {
  const section = page.getByRole('region', { name: '自定义端点' })
  await expect(section).toBeVisible()
  for (const [api, label] of [
    ['openai-completions', 'Chat Completions'],
    ['openai-responses', 'Responses'],
    ['anthropic-messages', 'Messages']
  ]) {
    await section.getByRole('button', { name: '添加端点', exact: true }).click()
    await section.locator('.endpoint-advanced > summary').click()
    await section.getByLabel('显示名称', { exact: true }).fill(label)
    await section.getByLabel('协议', { exact: true }).selectOption(api)
    await section.getByLabel('Base URL', { exact: true }).fill('https://example.invalid/v1')
    await section.getByLabel('API Key', { exact: true }).fill('isolated-test-key')
    await section.getByLabel('模型 ID', { exact: true }).fill('model-one\nmodel-two')
    await section.getByRole('button', { name: '保存端点', exact: true }).click()
    await expect(section.getByRole('status')).toContainText('端点已保存')
    await expect(section.getByLabel('API Key', { exact: true })).toHaveCount(0)
    await section.getByRole('button', { name: `编辑 ${label}`, exact: true }).click()
    await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('')
    await section.getByLabel('Base URL', { exact: true }).fill('https://example.invalid/edited')
    await section.getByRole('button', { name: '保存端点', exact: true }).click()
    await expect(section.getByLabel('API Key', { exact: true })).toHaveCount(0)
  }
  const config = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8'))
  const auth = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8'))
  expect(Object.values(config.providers).map((p: any) => p.api)).toEqual(
    expect.arrayContaining(['openai-completions', 'openai-responses', 'anthropic-messages'])
  )
  expect(Object.keys(auth).filter((id) => id.startsWith('custom-'))).toHaveLength(3)
  expect(await page.evaluate(async () => (await window.pi.getState()).activeProvider)).toBeNull()
  expect(JSON.stringify(await page.evaluate(() => window.pi.getState()))).not.toContain(
    'isolated-test-key'
  )
  expect(
    JSON.stringify(await page.evaluate(() => window.pi.send({ type: 'endpoint:list' })))
  ).not.toContain('isolated-test-key')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(section).toContainText('Chat Completions')
  await section.getByRole('button', { name: '编辑 Chat Completions', exact: true }).click()
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 1000 })
    await section.locator('.endpoint-form').scrollIntoViewIfNeeded()
    await section.getByRole('button', { name: '保存端点', exact: true }).scrollIntoViewIfNeeded()
    const geometry = await section.locator('.endpoint-form').evaluate((form) => {
      const bounds = form.getBoundingClientRect()
      return [...form.querySelectorAll('input,select,textarea,button')].every((field) => {
        const box = field.getBoundingClientRect()
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1
      })
    })
    expect(geometry).toBe(true)
    await page.screenshot({
      path: resolve(`artifacts/e2e/custom-endpoints${width === 960 ? '-960' : ''}.png`)
    })
  }
  await app.close()
  await launchFixture()
  const reopened = page.getByRole('region', { name: '自定义端点' })
  await expect(reopened).toContainText('Chat Completions')
  await expect(reopened).toContainText('Responses')
  await expect(reopened).toContainText('Messages')
  const state = await page.evaluate(() => window.pi.getState())
  expect(
    state.accounts.filter((account) => account.id.startsWith('custom-') && account.connected)
  ).toHaveLength(3)
  expect(state.models.filter((model) => model.provider.startsWith('custom-'))).toHaveLength(6)
  expect(state.activeProvider).toBeNull()
  await reopened.getByRole('button', { name: '编辑 Chat Completions', exact: true }).click()
  await expect(reopened.getByLabel('API Key', { exact: true })).toHaveValue('')
})

test('declares image input per model and restores the selection when editing', async () => {
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('模型 ID', { exact: true }).fill('old-model\ntext-only')
  await section.getByLabel('API Key', { exact: true }).fill('fixture-image-key')
  await expect(section.getByLabel('支持图片输入：old-model')).not.toBeChecked()
  await section.getByLabel('支持图片输入：old-model').check()
  await expect(section.getByLabel('支持图片输入：text-only')).not.toBeChecked()
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('端点已保存')
  const models = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8')).providers[
    'custom-existing'
  ].models
  expect(models).toEqual([{ id: 'old-model', input: ['text', 'image'] }, { id: 'text-only' }])
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'custom-existing', modelId: 'old-model' })
  )
  const active = await page.evaluate(() => window.pi.getState())
  expect(active.activeModel).toBe('old-model')
  expect(
    active.models.find((model) => model.provider === 'custom-existing' && model.id === 'old-model')
      ?.input
  ).toEqual(['text', 'image'])
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await expect(section.getByLabel('支持图片输入：old-model')).toBeChecked()
  await expect(section.getByLabel('支持图片输入：text-only')).not.toBeChecked()
  await section.getByLabel('模型 ID', { exact: true }).fill('text-only')
  await expect(section.getByLabel('支持图片输入：old-model')).toHaveCount(0)
  await section.getByLabel('模型 ID', { exact: true }).fill('old-model\ntext-only')
  await expect(section.getByLabel('支持图片输入：old-model')).not.toBeChecked()
  await section.getByLabel('支持图片输入：old-model').check()
  await section.getByLabel('支持图片输入：old-model').uncheck()
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('端点已保存')
  expect(
    JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8')).providers['custom-existing']
      .models[0].input
  ).toEqual(['text'])
})

test('UI-only unknown transport outcome never retries and credential-unknown partial status is explicit', async () => {
  const catalog = await page.evaluate(() => window.pi.send({ type: 'endpoint:list' }))
  await app.evaluate(({ ipcMain }, catalog) => {
    ipcMain.removeHandler('pi:command')
    let calls = 0
    ipcMain.handle('pi:command', (_event, command) => {
      if (command.type === 'endpoint:list') return catalog
      if (command.type === 'endpoint:save') {
        calls++
        ipcMain.on('endpoint-fixture:save-call', () => undefined)
        if (calls === 1)
          throw new Error('Injected transport timeout; Host operation could have completed')
        return {
          kind: 'endpoint-save',
          result: {
            ok: false,
            providerId: 'custom-existing',
            metadata: 'saved',
            credential: 'unknown',
            runtime: 'failed',
            selection: 'unchanged',
            message: '端点配置已保存，凭据保存结果不确定',
            snapshot: catalog.snapshot
          }
        }
      }
      throw new Error('Unexpected UI-only fixture command')
    })
  }, catalog)
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('API Key', { exact: true }).fill('unknown-fixture-key')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('保存结果未知')
  await expect(section.getByRole('alert')).toContainText('不会自动重试')
  await expect(section.getByLabel('API Key', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Enter')
  expect(
    await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('endpoint-fixture:save-call'))
  ).toBe(1)
  await section.getByRole('button', { name: '刷新列表', exact: true }).click()
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('')
  await section.getByLabel('API Key', { exact: true }).fill('explicit-new-fixture-key')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('凭据：结果不确定')
  await expect(section.getByRole('status')).toContainText('配置：已保存')
  await expect(section.getByLabel('API Key', { exact: true })).toHaveCount(0)
  expect(
    await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('endpoint-fixture:save-call'))
  ).toBe(2)
})

test('queued session change rejects the captured save before any canonical file write', async () => {
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  const original = await readFile(join(agentDir, 'models.json'), 'utf8')
  const result = await page.evaluate(
    async (cwd) => {
      const state = await window.pi.getState()
      const list = await window.pi.send({ type: 'endpoint:list' })
      return Promise.allSettled([
        window.pi.send({ type: 'session:new', providerId: 'endpoint-faux', modelId: 'fixture' }),
        window.pi.send({
          type: 'endpoint:save',
          context: { projectPath: cwd, sessionId: state.sessionId, generation: state.generation },
          request: {
            id: 'custom-existing',
            expectedRevision: list.snapshot.revision,
            endpoint: {
              label: 'stale form',
              api: 'openai-completions',
              baseUrl: 'https://example.invalid/v1',
              modelIds: ['old-model']
            }
          }
        })
      ]).then((values) => values.map((value) => value.status))
    },
    join(root, 'project')
  )
  expect(result).toEqual(['fulfilled', 'rejected'])
  expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toBe(original)
})

test('UI-only delayed list disables edits and a closed form ignores its late save response', async () => {
  const catalog = await page.evaluate(() => window.pi.send({ type: 'endpoint:list' }))
  await app.evaluate(({ ipcMain }, catalog) => {
    ipcMain.removeHandler('pi:command')
    let delayList = true
    ipcMain.handle('pi:command', (_event, command) => {
      if (command.type === 'endpoint:list') {
        if (!delayList) return catalog
        delayList = false
        return new Promise((resolve) =>
          ipcMain.once('endpoint-fixture:list', () => resolve(catalog))
        )
      }
      if (command.type === 'endpoint:save')
        return new Promise((resolve) =>
          ipcMain.once('endpoint-fixture:save', () =>
            resolve({
              kind: 'endpoint-save',
              result: {
                ok: true,
                providerId: 'custom-existing',
                metadata: 'saved',
                credential: 'saved',
                runtime: 'synchronized',
                selection: 'unchanged',
                message: '旧表单已保存',
                snapshot: catalog.snapshot
              }
            })
          )
        )
      throw new Error('UI-only fixture unexpected command')
    })
  }, catalog)
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '刷新列表', exact: true }).click()
  await expect(section.getByRole('button', { name: '编辑 未登录端点', exact: true })).toBeDisabled()
  await app.evaluate(({ ipcMain }) => ipcMain.emit('endpoint-fixture:list'))
  await expect(section.getByRole('button', { name: '编辑 未登录端点', exact: true })).toBeEnabled()
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('API Key', { exact: true }).fill('old-ephemeral-key')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled()
  await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('')
  expect(await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('endpoint-fixture:save'))).toBe(
    1
  )
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('显示名称', { exact: true }).fill('新表单')
  await section.getByLabel('API Key', { exact: true }).fill('new-ephemeral-key')
  await app.evaluate(({ ipcMain }) => ipcMain.emit('endpoint-fixture:save'))
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(section.getByLabel('显示名称', { exact: true })).toHaveValue('新表单')
  await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('new-ephemeral-key')
  await expect(section.getByRole('status')).toHaveCount(0)
})

test('reopening settings during an outstanding OAuth prompt restores the opener focus', async () => {
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.evaluate(() =>
    window.pi.send({ type: 'account:login', providerId: 'endpoint-oauth', method: 'browser' })
  )
  const prompt = page.getByLabel('Fixture OAuth gate', { exact: true })
  await expect(prompt).toBeVisible()
  // Remount the renderer while the Host retains its outstanding OAuth request.
  // This prevents a focus target captured by an earlier prompt-free open masking the bug.
  await page.reload()
  const opener = page.getByRole('button', { name: '设置', exact: true })
  await opener.click()
  await expect(prompt).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
  await opener.click()
  for (const closeWithEscape of [true, false]) {
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await opener.click()
    await expect(prompt).toBeFocused()
    if (closeWithEscape) await page.keyboard.press('Escape')
    else await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(opener).toBeFocused()
    expect((await page.evaluate(() => window.pi.getState())).loginPrompt?.message).toBe(
      'Fixture OAuth gate'
    )
    await opener.click()
  }
})

test('active OAuth rejects save and alias writes, leaves responders live, and busy stream disables editor', async () => {
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.evaluate(() =>
    window.pi.send({ type: 'account:login', providerId: 'endpoint-oauth', method: 'browser' })
  )
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).loginPrompt?.message))
    .toBe('Fixture OAuth gate')
  const original = await readFile(join(agentDir, 'models.json'), 'utf8')
  const rejected = await page.evaluate(async () => {
    const state = await window.pi.getState()
    const catalog = await window.pi.send({ type: 'endpoint:list' })
    let saveRejection = ''
    try { await window.pi.send({
      type: 'endpoint:save',
      context: {
        projectPath: state.project!.path,
        sessionId: state.sessionId,
        generation: state.generation
      },
      request: {
        id: 'custom-existing',
        expectedRevision: catalog.snapshot.revision,
        endpoint: {
          label: 'must-not-save',
          api: 'openai-completions',
          baseUrl: 'https://example.invalid',
          modelIds: ['old-model']
        }
      }
    })
    } catch (error) { saveRejection = String(error) }
    let aliasRejected = false
    try {
      await window.pi.send({ type: 'account:alias:add', slug: 'blocked' })
    } catch {
      aliasRejected = true
    }
    return {
      saveRejection,
      aliasRejected,
      promptStillActive: !!(await window.pi.getState()).loginPrompt
    }
  })
  expect(rejected.saveRejection).toContain('请先结束所有会话')
  expect(rejected.aliasRejected).toBe(true)
  expect(rejected.promptStillActive).toBe(true)
  expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toBe(original)
  await expect(
    page
      .getByRole('region', { name: '自定义端点' })
      .getByRole('button', { name: '添加端点', exact: true })
  ).toBeDisabled()
  await page.evaluate(async () => {
    const prompt = (await window.pi.getState()).loginPrompt!
    await window.pi.send({ type: 'account:login:respond', promptId: prompt.id, value: 'continue' })
  })
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).login.phase))
    .toBe('success')
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'endpoint-faux', modelId: 'fixture' })
  )
  await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({
      type: 'prompt:send',
      text: '/fixture-endpoint-stream',
      sessionId: sessionId!,
      generation
    })
  })
  await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({
      type: 'prompt:send',
      text: 'offline busy fixture',
      sessionId: sessionId!,
      generation
    })
  })
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  await expect(
    page
      .getByRole('region', { name: '自定义端点' })
      .getByRole('button', { name: '添加端点', exact: true })
  ).toBeDisabled()
  await page.evaluate(() => window.pi.send({ type: 'prompt:abort' }))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
})

test('same-ID key edit preserves canonical transcript and model removal requires explicit selection', async () => {
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    const catalog = await window.pi.send({ type: 'endpoint:list' })
    await window.pi.send({
      type: 'endpoint:save',
      context: { projectPath: null, sessionId: state.sessionId, generation: state.generation },
      request: {
        id: 'custom-existing',
        expectedRevision: catalog.snapshot.revision,
        endpoint: {
          label: '未登录端点',
          api: 'openai-completions',
          baseUrl: 'https://example.invalid/v1',
          modelIds: ['old-model', 'replacement'],
          key: 'fixture-initial'
        }
      }
    })
  })
  const project = join(root, 'project')
  const bucket = join(
    agentDir,
    'sessions',
    `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  await mkdir(bucket, { recursive: true })
  const transcript = join(bucket, '2026-09-11T00-00-00-000Z_endpoint-history.jsonl')
  const timestamp = '2026-09-11T00:00:00.000Z'
  await writeFile(
    transcript,
    [
      { type: 'session', version: 3, id: 'endpoint-history', timestamp, cwd: project },
      {
        type: 'model_change',
        id: 'm1',
        parentId: null,
        timestamp,
        provider: 'custom-existing',
        modelId: 'old-model'
      },
      {
        type: 'message',
        id: 'u1',
        parentId: 'm1',
        timestamp,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '端点编辑保留这段历史' }],
          timestamp: Date.parse(timestamp)
        }
      }
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n'
  )
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), transcript)
  await expect(page.locator('.node-flow')).toContainText('端点编辑保留这段历史')
  const before = await readFile(transcript, 'utf8')
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('API Key', { exact: true }).fill('fixture-replacement')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('端点已保存')
  const after = await readFile(transcript, 'utf8')
  expect(after.startsWith(before)).toBe(true)
  expect(after.slice(before.length)).toContain('model_change')
  expect((await page.evaluate(() => window.pi.getState())).activeModel).toBe('old-model')
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('')
  await section.getByLabel('模型 ID', { exact: true }).fill('replacement')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('确认')
  await section.getByLabel('确认移除上述模型').check()
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).composeBlockReason))
    .toBe('endpoint-selection-invalidated')
  await expect(page.locator('.node-flow')).toContainText('端点编辑保留这段历史')
  const invalid = await page.evaluate(async () => {
    try {
      const { sessionId, generation } = await window.pi.getState()
      await window.pi.send({
        type: 'prompt:send',
        text: 'must not send',
        sessionId: sessionId!,
        generation
      })
      return false
    } catch {
      return true
    }
  })
  expect(invalid).toBe(true)
  // A later successful global save synchronizes runtime, but cannot choose a replacement for this session.
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    const list = await window.pi.send({ type: 'endpoint:list' })
    await window.pi.send({
      type: 'endpoint:save',
      context: {
        projectPath: state.project!.path,
        sessionId: state.sessionId,
        generation: state.generation
      },
      request: {
        expectedRevision: list.snapshot.revision,
        endpoint: {
          label: '其他端点',
          api: 'openai-responses',
          baseUrl: 'https://other.invalid',
          modelIds: ['other'],
          key: 'other-fixture'
        }
      }
    })
  })
  expect((await page.evaluate(() => window.pi.getState())).composeBlockReason).toBe(
    'endpoint-selection-invalidated'
  )
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'custom-existing', modelId: 'replacement' })
  )
  expect((await page.evaluate(() => window.pi.getState())).composeBlockReason).toBeNull()
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), transcript)
  expect((await page.evaluate(() => window.pi.getState())).activeModel).toBe('replacement')
  await expect(page.locator('.node-flow')).toContainText('端点编辑保留这段历史')
})

test('edits metadata without credentials, validates input and cancels without writes', async () => {
  const section = page.getByRole('region', { name: '自定义端点' })
  const original = await readFile(join(agentDir, 'models.json'), 'utf8')
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('')
  await section.getByLabel('Base URL', { exact: true }).fill('http://example.invalid')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('HTTPS')
  await section.getByLabel('Base URL', { exact: true }).fill('https://example.invalid/v1')
  await section.getByLabel('模型 ID', { exact: true }).fill('duplicate\nduplicate')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('重复')
  await section.getByRole('button', { name: '取消编辑', exact: true }).click()
  expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toBe(original)
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('显示名称', { exact: true }).fill('改名后的端点')
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('端点已保存')
  await expect(section).toContainText('改名后的端点')
  // Subscriptions and both engines' API connections share the page with Pi's endpoints.
  await expect(page.getByRole('region', { name: '订阅账号' })).toBeVisible()
  await expect(page.getByRole('button', { name: /添加订阅账号/ })).toBeEnabled()
  await expect(page.getByRole('region', { name: 'API 连接' })).toContainText('Claude Code API')
})

test('canonical metadata survives runtime refresh failure and list refresh truthfully only rereads it', async () => {
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'endpoint-faux', modelId: 'fixture' })
  )
  const section = page.getByRole('region', { name: '自定义端点' })
  await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
  await section.getByLabel('显示名称', { exact: true }).fill('部分保存端点')
  // Obstruct only the isolated credential path after ModelRuntime initialization.
  const authPath = join(agentDir, 'auth.json')
  await rename(authPath, `${authPath}.fixture-backup`)
  await mkdir(authPath)
  try {
    await section.getByRole('button', { name: '保存端点', exact: true }).click()
    await expect(section.getByRole('status')).toContainText('运行时未同步')
    await expect(section.getByRole('status')).toContainText('配置：已保存')
    expect((await page.evaluate(() => window.pi.getState())).composeBlockReason).toBe(
      'endpoint-runtime-unsynchronized'
    )
    expect(
      JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8')).providers['custom-existing']
        .name
    ).toBe('部分保存端点')
    await page.screenshot({ path: resolve('artifacts/e2e/custom-endpoints-partial.png') })
    await section.getByRole('button', { name: '刷新列表', exact: true }).click()
    await expect(
      section.getByRole('button', { name: '编辑 部分保存端点', exact: true })
    ).toBeVisible()
    expect((await page.evaluate(() => window.pi.getState())).composeBlockReason).toBe(
      'endpoint-runtime-unsynchronized'
    )
  } finally {
    await rm(authPath, { recursive: true })
    await rename(`${authPath}.fixture-backup`, authPath)
  }
  await section.getByRole('button', { name: '编辑 部分保存端点', exact: true }).click()
  await section.getByRole('button', { name: '保存端点', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('端点已保存')
  expect((await page.evaluate(() => window.pi.getState())).composeBlockReason).toBeNull()
})


test('discovers and saves models using only URL and key', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer discovery-fixture') {
      res.writeHead(401).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'discovered-one' }, { id: 'discovered-two' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing local address')
    const section = page.getByRole('region', { name: '自定义端点' })
    await section.getByRole('button', { name: '添加端点', exact: true }).click()
    await section.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${address.port}`)
    await section.getByLabel('API Key', { exact: true }).fill('discovery-fixture')
    await section.getByRole('button', { name: '拉取模型', exact: true }).click()
    await expect(section.getByRole('status')).toContainText('已获取 2 个模型')
    await expect(section.getByLabel('Base URL', { exact: true })).toHaveValue(`http://127.0.0.1:${address.port}/v1`)
    await page.screenshot({ path: 'artifacts/e2e/endpoint-discovery.png' })
    await section.getByRole('button', { name: '保存端点', exact: true }).click()
    await expect(section.getByRole('button', { name: '编辑 127.0.0.1', exact: true })).toBeVisible()
    const config = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8'))
    expect(Object.values(config.providers)).toContainEqual(expect.objectContaining({
      name: '127.0.0.1', models: expect.arrayContaining([expect.objectContaining({ id: 'discovered-one' }), expect.objectContaining({ id: 'discovered-two' })])
    }))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('discovery errors preserve the draft and cancelled discovery cannot overwrite another form', async () => {
  let delayed: import('node:http').ServerResponse | undefined
  const server = createServer((req, res) => {
    if (req.headers.authorization === 'Bearer wrong-fixture') res.writeHead(401).end('private upstream error')
    else delayed = res
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing local address')
    const section = page.getByRole('region', { name: '自定义端点' })
    await section.getByRole('button', { name: '添加端点', exact: true }).click()
    await section.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${address.port}`)
    await section.getByLabel('API Key', { exact: true }).fill('wrong-fixture')
    await section.getByRole('button', { name: '拉取模型', exact: true }).click()
    await expect(section.getByRole('alert')).toContainText('认证失败')
    await expect(section.getByRole('alert')).not.toContainText('private upstream error')
    await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('wrong-fixture')
    await section.getByLabel('API Key', { exact: true }).fill('right-fixture')
    await section.getByRole('button', { name: '拉取模型', exact: true }).click()
    await expect.poll(() => Boolean(delayed)).toBe(true)
    await section.getByRole('button', { name: '取消编辑', exact: true }).click()
    await section.getByRole('button', { name: '编辑 未登录端点', exact: true }).click()
    delayed!.setHeader('content-type', 'application/json')
    delayed!.end(JSON.stringify({ data: [{ id: 'stale-model' }] }))
    // A following Host command fences the completed discovery response.
    await page.evaluate(() => window.pi.send({ type: 'endpoint:list' }))
    await expect(section.getByLabel('模型 ID', { exact: true })).toHaveValue('old-model')
    await expect(section.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(section.getByRole('status')).toHaveCount(0)
  } finally {
    delayed?.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
