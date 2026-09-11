import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
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
  pb: string,
  empty: string
const artifacts = resolve('artifacts/e2e/project-navigation-20260911')
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-navigation-')))
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
  pb = await seed(b, 'b-exact', '指定目标会话', 10)
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
  app = await electron.launch({
    args: [resolve('.')],
    cwd: a,
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

test('actual catalog preserves active state, paginates, opens exact cross-project targets and retains both drafts', async () => {
  const before = await page.evaluate(() => window.pi.getState())
  await page.locator('.composer-input').fill('A 未发送草稿')
  await group(b).locator('.project-group-toggle').click()
  await group(b).locator('.project-group-toggle').click()
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe('a-main')
  expect((await page.evaluate(() => window.pi.getState())).activeModel).toBe(before.activeModel)
  await expect(page.locator('.composer-input')).toHaveValue('A 未发送草稿')
  await expect(group(b).locator('.project-session-row')).toHaveCount(50)
  await group(b)
    .getByRole('button', { name: /显示更多/ })
    .click()
  await expect(group(b).locator('.project-session-row')).toHaveCount(52)
  await page.getByRole('textbox', { name: '搜索会话标题' }).fill('指定目标')
  await expect(group(b).locator('.project-session-row')).toHaveCount(1)
  await group(b)
    .getByRole('button', { name: /指定目标会话/ })
    .click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeSessionPath))
    .toBe(pb)
  await expect(page.locator('.node-flow')).toContainText('指定目标会话 的回答')
  await page.locator('.composer-input').fill('B 未发送草稿')
  await page.getByRole('button', { name: '清除搜索' }).click()
  await group(a)
    .getByRole('button', { name: /导航体验与布局/ })
    .click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeSessionPath))
    .toBe(pa)
  await expect(page.locator('.composer-input')).toHaveValue('A 未发送草稿')
  await group(b)
    .getByRole('button', { name: /显示更多/ })
    .click()
  await group(b)
    .getByRole('button', { name: /指定目标会话/ })
    .click()
  await expect(page.locator('.composer-input')).toHaveValue('B 未发送草稿')
  await group(a)
    .getByRole('button', { name: /导航体验与布局/ })
    .click()
  await group(b).locator('.project-group-toggle').click()
  for (const width of [960, 1240, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width
    )
    await expect.poll(() => page.evaluate(() => window.outerWidth)).toBe(width)
    await expect(page.locator('.sidebar')).toHaveCSS('width', width === 960 ? '232px' : '280px')
    await expect(group(a).locator('.project-session-row').first()).toHaveCSS(
      'flex-direction',
      'row'
    )
    const shot = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')
    )
    await writeFile(join(artifacts, `navigation-${width}.png`), Buffer.from(shot, 'base64'))
  }
  await page.keyboard.press('Meta+b')
  await expect(page.locator('.sidebar')).toHaveCSS('width', '56px')
  await page.keyboard.press('Meta+b')
  await expect(group(b).locator('.project-group-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test('new session targets empty project directly, stale intent cannot activate, and unavailable cwd is local', async () => {
  await expect(group(join(root, 'removed'))).toContainText('项目目录不可用')
  await group(join(root, 'removed')).getByRole('button', { name: '重试' }).click()
  await expect(group(join(root, 'removed'))).toContainText('项目目录不可用')
  const source = await page.evaluate(() => window.pi.getState())
  await group(empty).getByRole('button', { name: '在 empty 中新建会话' }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).project?.path))
    .toBe(empty)
  const current = await page.evaluate(() => window.pi.getState())
  expect(current.nodes.filter((node) => node.type === 'user' || node.type === 'assistant')).toEqual(
    []
  )
  const rejected = await page.evaluate(
    async ({ a, pa, source }) => {
      try {
        await window.pi.send({
          type: 'project:navigate',
          cwd: a,
          sessionPath: pa,
          sessionId: source.sessionId,
          generation: source.generation
        })
        return false
      } catch {
        return true
      }
    },
    { a, pa, source }
  )
  expect(rejected).toBe(true)
  expect((await page.evaluate(() => window.pi.getState())).sessionId).toBe(current.sessionId)
  const persisted = JSON.parse(
    await readFile(join(root, 'user-data', 'pi-desktop-preferences.json'), 'utf8')
  )
  expect(persisted.recentProjects[0]).toBe(empty)
})

test('a target removed after discovery reports failure in that project and retries only on request', async () => {
  await page.locator('.composer-input').fill('A 的待发送草稿')
  await group(b)
    .getByRole('button', { name: /显示更多/ })
    .click()
  await expect(group(b).locator('.project-session-row')).toHaveCount(52)
  await rm(b, { recursive: true })
  await group(b)
    .getByRole('button', { name: /指定目标会话/ })
    .click()
  await expect(group(b).getByRole('alert')).toContainText('所选项目目录不可用')
  await expect(group(a).getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.composer-input')).toHaveValue('A 的待发送草稿')
  expect((await page.evaluate(() => window.pi.getState())).activeSessionPath).toBe(pa)
  await page.getByRole('textbox', { name: '搜索会话标题' }).fill('导航体验')
  await expect(group(b).getByRole('alert')).toContainText('所选项目目录不可用')
  await page.getByRole('button', { name: '清除搜索' }).click()
  await group(b).locator('.project-group-toggle').click()
  await expect(group(b).locator('.project-group-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(group(b).getByRole('alert')).toBeVisible()
  await mkdir(b, { recursive: true })
  // Restoring a directory never replays the failed navigation automatically.
  expect((await page.evaluate(() => window.pi.getState())).activeSessionPath).toBe(pa)
  const failedGeneration = (await page.evaluate(() => window.pi.getState())).generation
  await group(a)
    .getByRole('button', { name: /会话草稿保留/ })
    .click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).generation))
    .toBeGreaterThan(failedGeneration)
  // Retry must capture this new source identity, not replay the failed A-main command.
  await group(b).getByRole('button', { name: '重试打开会话' }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeSessionPath))
    .toBe(pb)
  await expect(group(b).getByRole('alert')).toHaveCount(0)
  await group(a)
    .getByRole('button', { name: /导航体验与布局/ })
    .click()
  await expect(page.locator('.composer-input')).toHaveValue('A 的待发送草稿')
})
