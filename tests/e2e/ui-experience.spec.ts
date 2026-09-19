import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PiDesktopAPI } from '../../src/shared/contracts'
declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}

let app: ElectronApplication,
  page: Page,
  root: string,
  a: string,
  b: string,
  pa: string,
  empty: string
const artifacts = resolve('artifacts/e2e/ui-experience')
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-ui-experience-')))
  a = join(root, 'one', 'studio')
  b = join(root, 'two', 'studio')
  empty = join(root, 'empty')
  const agentDir = join(root, 'agent')
  const bucket = (cwd: string) =>
    join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  for (const path of [
    a,
    b,
    empty,
    join(root, 'home'),
    join(root, 'user-data'),
    join(agentDir, 'extensions'),
    artifacts
  ])
    await mkdir(path, { recursive: true })
  const seed = async (cwd: string, id: string, title: string, index = 0) => {
    await mkdir(bucket(cwd), { recursive: true })
    const timestamp = new Date(Date.UTC(2026, 8, 11, 0, 0, index)).toISOString()
    const path = join(bucket(cwd), id + '.jsonl')
    const entries = [
      { type: 'session', version: 3, id, timestamp, cwd },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp,
        provider: 'navigation-faux',
        modelId: 'fixture'
      },
      {
        type: 'thinking_level_change',
        id: 'thinking',
        parentId: 'model',
        timestamp,
        thinkingLevel: 'off'
      },
      {
        type: 'message',
        id: 'u',
        parentId: 'thinking',
        timestamp,
        message: { role: 'user', content: `${title} 的原始问题`, timestamp: Date.parse(timestamp) }
      },
      {
        type: 'message',
        id: 'a',
        parentId: 'u',
        timestamp,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `${title} 的回答。\n\n项目会话各自保存，导航不会自动发送任务。` }
          ],
          api: 'openai-completions',
          provider: 'navigation-faux',
          model: 'fixture',
          stopReason: 'stop',
          timestamp: Date.parse(timestamp) + 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
      },
      { type: 'session_info', id: 'name', parentId: 'a', timestamp, name: title }
    ]
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    return path
  }
  pa = await seed(a, 'a-main', '导航体验与布局', 10)
  await seed(a, 'a-older', '会话草稿保留', 5)
  await seed(b, 'b-exact', '指定目标会话', 10)
  await seed(b, 'b-latest', '另一个较新会话', 20)
  for (let index = 0; index < 50; index++)
    await seed(b, `history-${index}`, `归档讨论 ${index}`, index + 30)
  await seed(join(root, 'removed'), 'missing', '目录已移动')
  const collision1 = join(root, 'a-b'),
    collision2 = join(root, 'a', 'b')
  await mkdir(collision1, { recursive: true })
  await mkdir(collision2, { recursive: true })
  await seed(collision1, 'collision-one', '连字符项目')
  await seed(collision2, 'collision-two', '嵌套路径项目')
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'navigation-faux': {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          models: [
            {
              id: 'fixture',
              name: 'Fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ 'navigation-faux': { type: 'api_key', key: 'offline-fixture-only' } })
  )
  await writeFile(
    join(root, 'user-data', 'pi-desktop-preferences.json'),
    JSON.stringify({ lastProjectPath: a, recentProjects: [a, b, empty] })
  )
  // Hold actual runtime preparation so pending UI assertions are deterministic.
  await writeFile(
    join(agentDir, 'extensions', 'navigation-delay.ts'),
    `
    import { existsSync } from 'node:fs';
    export default async function () {
      while (existsSync(${JSON.stringify(join(root, 'navigation-delay'))}))
        await new Promise(resolve => setTimeout(resolve, 20));
    }
  `
  )
  const ai = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(ai, 'package.json'), 'utf8'))
  await writeFile(
    join(agentDir, 'extensions', 'ui-fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(resolve(ai, pkg.exports['.'].import))};
    export default function(pi) {
      const faux = fauxProvider({ provider: 'ui-fixture', api: 'ui-fixture-api', models: [{id:'offline'}], tokensPerSecond:40, tokenSize:{min:4,max:4} });
      const respond = async (context) => {
        const user = context.messages.filter(m => m.role === 'user').at(-1);
        if (JSON.stringify(user?.content).includes('UI_APPROVAL') && context.messages.at(-1)?.role !== 'toolResult')
          return fauxAssistantMessage(fauxToolCall('bash', {command: 'echo approved'}, {id:'ui-approval'}), {stopReason:'toolUse'});
        return fauxAssistantMessage('正在独立验证操作体验。'.repeat(200));
      };
      faux.setResponses([respond, respond, respond]); pi.registerProvider(faux.provider);
    }
  `
  )
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'navigation-faux': { type: 'api_key', key: 'offline-fixture-only' },
      'ui-fixture': { type: 'api_key', key: 'offline-fixture-only' }
    })
  )
  await launchApplication()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .toBe('a-main')
  await expect(page.locator('.project-group')).toHaveCount(6)
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})
const group = (cwd: string) =>
  page
    .locator('.project-group')
    .filter({ has: page.locator(`button.project-group-toggle[title=${JSON.stringify(cwd)}]`) })

async function launchApplication(): Promise<void> {
  const agentDir = join(root, 'agent')
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
    cwd: a,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
      ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
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
}

const clickProjectMenu = async (cwd: string): Promise<void> => {
  await group(cwd).locator('.project-group-head').hover()
  await group(cwd).locator('.project-group-head .navigation-more').click()
}
const closeNotice = async (): Promise<void> => {
  const button = page.getByRole('button', { name: '关闭提示', exact: true })
  if (await button.count()) await button.click()
}

test('single-line project headers support keyboard menus, display names, pinning and copying', async () => {
  const original = await readFile(pa, 'utf8')
  await expect(group(a).locator('.project-path-hint')).toHaveCount(0)
  await expect(group(a).locator('.project-name-hint')).toHaveText('one')
  await group(a).locator('.project-group-toggle').focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: '修改显示名称', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '修改显示名称', exact: true }).click()
  const input = page.getByRole('textbox', { name: '名称', exact: true })
  await expect(input).toBeFocused()
  await input.fill('Pi 工作区')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(group(a).locator('.project-name')).toHaveText('Pi 工作区')
  await clickProjectMenu(a)
  await page.getByRole('menuitem', { name: '置顶项目', exact: true }).click()
  await closeNotice()
  await expect(group(a).getByLabel('已置顶')).toBeVisible()
  await clickProjectMenu(a)
  await page.getByRole('menuitem', { name: '复制项目路径', exact: true }).click()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(a)
  expect(await readFile(pa, 'utf8')).toBe(original)
  await closeNotice()
  await page.screenshot({ path: join(artifacts, 'light-conversation.png') })
  await page.evaluate(async () => {
    const settings = await window.pi.desktopSettings({ type: 'get' })
    await window.pi.desktopSettings({ type: 'save', settings: { ...settings, theme: 'dark' } })
  })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(group(a).locator('.project-name')).toHaveText('Pi 工作区')
  await clickProjectMenu(a)
  await page.screenshot({ path: join(artifacts, 'dark-project-menu.png') })
})

test('removing the selected project closes only the foreground and survives a restart; undo restores history', async () => {
  const original = await readFile(pa, 'utf8')
  await page.locator('.composer-input').fill('项目独立草稿')
  await clickProjectMenu(a)
  await page.getByRole('menuitem', { name: '从侧栏移除', exact: true }).click()
  await expect(group(a)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).project))
    .toBeNull()
  await expect(page.getByText('从一个项目开始。', { exact: true })).toBeVisible()
  expect(await readFile(pa, 'utf8')).toBe(original)
  const catalog = await page.evaluate(() => window.pi.send({ type: 'project:catalog' }))
  expect(catalog.catalog.projects.some((project) => project.path === a)).toBe(false)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(group(a)).toHaveCount(1)
  await group(a).locator('.project-session-row').filter({ hasText: '导航体验与布局' }).click()
  await expect(page.locator('.composer-input')).toHaveValue('项目独立草稿')
  await clickProjectMenu(a)
  await page.getByRole('menuitem', { name: '从侧栏移除', exact: true }).click()
  await expect(group(a)).toHaveCount(0)
  await app.close()
  await launchApplication()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await expect(group(a)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).project))
    .toBeNull()
  await page.getByRole('button', { name: '管理项目与归档', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '管理项目与归档' })).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'restore-project.png') })
  await page.getByRole('button', { name: '恢复 studio', exact: true }).click()
  await page.getByRole('button', { name: '关闭管理', exact: true }).click()
  await expect(group(a)).toHaveCount(1)
  await group(a).locator('.project-session-row').filter({ hasText: '导航体验与布局' }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .toBe('a-main')
  expect(await readFile(pa, 'utf8')).toBe(original)
})

test('session actions rename the original history without navigation and archive with a recoverable entry', async () => {
  const other = group(a).locator('.project-session-item').filter({ hasText: '会话草稿保留' })
  await other.hover()
  await other.locator('.navigation-more').click()
  await page.getByRole('menuitem', { name: '重命名会话', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('已重命名的历史')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(group(a).getByText('已重命名的历史', { exact: true })).toBeVisible()
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe('a-main')
  const renamed = group(a).locator('.project-session-item').filter({ hasText: '已重命名的历史' })
  await renamed.hover()
  await renamed.locator('.navigation-more').click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  await expect(group(a).getByText('已重命名的历史', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '管理项目与归档', exact: true }).click()
  await page.getByRole('button', { name: /已归档的会话/ }).click()
  await expect(page.getByRole('button', { name: '恢复 已重命名的历史', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复 已重命名的历史', exact: true }).click()
  await page.getByRole('button', { name: '关闭管理', exact: true }).click()
  await expect(group(a).getByText('已重命名的历史', { exact: true })).toBeVisible()
})

test('stop stays available with a draft, queueing is explicit, and native removal is blocked while running', async () => {
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'ui-fixture', modelId: 'offline' })
  )
  await page.locator('.composer-input').fill('UI_RUNNING 验证独立停止与队列')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(true)
  await page.locator('.composer-input').fill('稍后执行的补充指令')
  await expect(page.getByRole('button', { name: '停止当前运行', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '加入发送队列', exact: true })).toBeEnabled()
  await clickProjectMenu(a)
  await expect(page.getByRole('menuitem', { name: /从侧栏移除/ })).toBeDisabled()
  await page.keyboard.press('Escape')
  const rejection = await page.evaluate(async (cwd) => {
    try {
      await window.pi.navigationLibrary({ type: 'project:hide', cwd })
      return ''
    } catch (error) {
      return String(error)
    }
  }, a)
  expect(rejection).toMatch(/运行|确认/)
  await page.getByRole('button', { name: '加入发送队列', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).queuedCount))
    .toBe(1)
  await page.locator('.composer-input').fill('停止后保留的草稿')
  await page.screenshot({ path: join(artifacts, 'running-with-queue.png') })
  await page.evaluate(() => window.pi.send({ type: 'queue:clear' }))
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(page.locator('.composer-input')).toHaveValue('停止后保留的草稿')
})

test('narrow layouts retain primary controls; searchable model selection does not switch accounts while browsing', async () => {
  const before = await page.evaluate(() => window.pi.getState())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
  await page.getByRole('button', { name: '选择模型', exact: true }).click()
  await page.getByRole('combobox', { name: '搜索账号与模型', exact: true }).fill('ui-fixture')
  await expect(
    page.locator('.model-picker [cmdk-item]').filter({ hasText: 'offline' })
  ).toBeVisible()
  expect((await page.evaluate(() => window.pi.getState())).activeProvider).toBe(
    before.activeProvider
  )
  await page.screenshot({ path: join(artifacts, 'narrow-model-picker.png') })
  await page.keyboard.press('Escape')
  const geometry = await page.evaluate(() => {
    const composer = document.querySelector('.composer')!.getBoundingClientRect()
    const send = document.querySelector('.send')!.getBoundingClientRect()
    return {
      bodyWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      within: send.right <= composer.right && send.left >= composer.left
    }
  })
  expect(geometry.contentWidth).toBe(geometry.bodyWidth)
  expect(geometry.within).toBe(true)
  const resize = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await resize.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.pi.navigationLibrary({ type: 'get' })).layout.sidebarWidth
      )
    )
    .toBe(256)
  await page.reload()
  await expect(resize).toHaveAttribute('aria-valuenow', '256')
})

test('pending approvals stay visible and cannot be removed through the project menu or native IPC', async () => {
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'ui-fixture', modelId: 'offline' })
  )
  await page.locator('.composer-input').fill('UI_APPROVAL 需要确认的操作')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await clickProjectMenu(a)
  await expect(page.getByRole('menuitem', { name: /从侧栏移除/ })).toBeDisabled()
  await page.keyboard.press('Escape')
  const approval = page.locator('.approval-card')
  await expect(approval.getByLabel('将执行的命令', { exact: true })).toHaveText('echo approved')
  await expect(approval).toContainText('仅本次操作')
  await expect(approval.locator('details')).toHaveCount(0)
  await expect(page.locator('.approval-jump')).toHaveCount(0)
  await expect(page.locator('.work-summary-trigger').last()).toContainText('已暂停')
  await page.screenshot({ path: join(artifacts, 'awaiting-approval.png') })
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await page.screenshot({ path: join(artifacts, 'awaiting-approval-dark.png'), animations: 'disabled' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
  // Compact layout may keep the decision row visible or move it just offscreen.
  // Either way the pending decision must remain reachable without layout overflow.
  const allow = approval.getByRole('button', { name: '允许一次', exact: true })
  const jump = page.locator('.approval-jump')
  await expect
    .poll(async () => {
      if (await jump.isVisible()) return true
      return allow.evaluate((element) => {
        const root = element.closest('.conversation-scroll')
        if (!root) return false
        const actionRect = element.closest('[data-approval-actions]')?.getBoundingClientRect()
        const rootRect = root.getBoundingClientRect()
        if (!actionRect) return false
        const visibleHeight =
          Math.min(actionRect.bottom, rootRect.bottom) - Math.max(actionRect.top, rootRect.top)
        return visibleHeight >= actionRect.height * 0.99
      })
    })
    .toBe(true)
  if (await jump.isVisible()) await jump.click()
  await expect(allow).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(artifacts, 'awaiting-approval-narrow.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
})

test('archiving the selected conversation preserves bytes and defaults search to unarchived items', async () => {
  const original = await readFile(pa, 'utf8')
  const current = group(a).locator('.project-session-item.is-active')
  await current.hover()
  await current.locator('.navigation-more').click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).project))
    .toBeNull()
  expect(await readFile(pa, 'utf8')).toBe(original)
  const results = await page.evaluate(async () => {
    const visible = await window.pi.send({
      type: 'session:search',
      query: '导航体验与布局',
      limit: 50
    })
    const archived = await window.pi.send({
      type: 'session:search',
      query: '导航体验与布局',
      limit: 50,
      includeArchived: true
    })
    return { visible: visible.result.total, archived: archived.result.total }
  })
  expect(results).toEqual({ visible: 0, archived: 1 })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(group(a).getByText('导航体验与布局', { exact: true })).toBeVisible()
})


test('header owns the divider and initial model metadata does not produce a false section break', async () => {
  const original = await readFile(pa, 'utf8')
  expect((await page.evaluate(() => window.pi.getState())).nodes.some(node => node.type === 'model' && node.initial)).toBe(true)
  await expect(page.locator('.history-note')).toHaveCount(0)
  await expect(page.locator('.conversation-head')).toHaveCSS('border-bottom-width', '1px')
  await expect(page.locator('.conversation-head')).toHaveCSS('border-bottom-style', 'solid')
  await page.evaluate(() => window.pi.send({ type: 'model:set', providerId: 'ui-fixture', modelId: 'offline' }))
  await expect(page.locator('.history-note')).toHaveCount(1)
  await expect(page.locator('.history-note')).toHaveText('模型切换 · ui-fixture / offline')
  await expect(page.locator('.history-note')).toHaveCSS('border-top-width', '0px')
  await page.screenshot({ path: join(artifacts, 'header-and-model-event.png') })
  expect(await readFile(pa, 'utf8')).toContain(original.trim())
  await page.getByRole('button', { name: '收起侧栏（⌘B）', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'header-collapsed-sidebar.png') })
})

test('offscreen approval hint appears only while its controls are outside the reading viewport', async () => {
  await app.close()
  const entries = (await readFile(pa, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  entries.find(entry => entry.message?.role === 'assistant').message.content[0].text =
    Array.from({ length: 55 }, (_, i) => `${i + 1}. 正在检查项目里的布局和操作体验。`).join('\n\n')
  await writeFile(pa, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  await launchApplication()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId)).toBe('a-main')
  await page.evaluate(() => window.pi.send({ type: 'model:set', providerId: 'ui-fixture', modelId: 'offline' }))
  await page.locator('.composer-input').fill('UI_APPROVAL 确认前先回看历史')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  const approval = page.locator('.approval-card')
  await expect(approval).toBeVisible()
  await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(approval.getByRole('button', { name: '允许一次', exact: true })).toBeInViewport()
  await expect(page.locator('.approval-jump')).toHaveCount(0)
  const top = await page.locator('.conversation-head').evaluate(el => el.getBoundingClientRect().top)
  await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0 })
  await expect(page.locator('.approval-jump')).toBeVisible()
  expect(await page.locator('.conversation-head').evaluate(el => el.getBoundingClientRect().top)).toBe(top)
  await page.locator('.approval-jump').click()
  await expect(approval).toBeFocused()
  await expect(approval.getByRole('button', { name: '允许一次', exact: true })).toBeInViewport()
  await expect(page.locator('.approval-jump')).toHaveCount(0)
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect(approval).toHaveCount(0)
  await expect(page.locator('.approval-jump')).toHaveCount(0)
})

test('approval submission locks both choices, supports retry and never applies a reply to a new request', async () => {
  const windowReady = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }) => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    void win.loadURL('about:blank')
  })
  const harness = await windowReady
  const bundle = await build({
    stdin: { loader: 'tsx', resolveDir: resolve('.'), contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import ApprovalCard from ${JSON.stringify(resolve('src/renderer/src/components/ApprovalCard.tsx'))};
      window.calls=[]; window.resolvers=[];
      const request={id:'first',generation:1,toolCallId:'call',toolName:'bash',intent:'terminal',title:'Run',detail:JSON.stringify({command:'echo pending'})};
      function Harness(){ const [id,setId]=useState('first');window.newRequest=()=>setId('second');return <main className="conversation"><ApprovalCard key={id} request={{...request,id}} projectPath="/isolated" onApproval={(id,allow)=>{window.calls.push({id,allow});return new Promise(resolve=>window.resolvers.push(resolve))}}/></main> }
      createRoot(document.getElementById('root')).render(<Harness/>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }
  })
  await harness.setContent('<div id="root"></div>')
  for (const file of ['main.css', 'theme.css', 'approval.css'])
    await harness.addStyleTag({ content: await readFile(resolve('src/renderer/src/assets', file), 'utf8') })
  await harness.addScriptTag({ content: bundle.outputFiles[0].text })
  const allow = harness.getByRole('button', { name: '允许一次', exact: true })
  const deny = harness.getByRole('button', { name: '拒绝', exact: true })
  await expect(allow).toBeVisible()
  await harness.getByLabel('将执行的命令', { exact: true }).focus()
  await harness.keyboard.press('Enter')
  expect(await harness.evaluate(() => (window as any).calls)).toEqual([])
  await allow.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  expect(await harness.evaluate(() => (window as any).calls)).toEqual([{ id: 'first', allow: true }])
  await expect(allow).toBeDisabled()
  await expect(deny).toBeDisabled()
  await harness.evaluate(() => (window as any).resolvers[0](false))
  await expect(harness.getByRole('alert')).toHaveText('确认未能提交，请重试。')
  await expect(allow).toBeEnabled()
  await allow.click()
  await harness.evaluate(() => (window as any).newRequest())
  await expect(allow).toBeEnabled()
  await harness.evaluate(() => (window as any).resolvers[1](true))
  await expect(allow).toBeEnabled()
  await deny.click()
  await harness.evaluate(() => (window as any).resolvers[2](true))
  await expect(deny).toBeDisabled()
  await expect(harness.getByRole('status').last()).toHaveText('已提交，等待操作状态更新…')
  expect(await harness.evaluate(() => (window as any).calls)).toEqual([
    { id: 'first', allow: true }, { id: 'first', allow: true }, { id: 'second', allow: false }
  ])
})
