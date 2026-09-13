import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  access,
  chmod,
  constants,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PiDesktopAPI } from '../../src/shared/contracts'

declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}

let app: ElectronApplication
let page: Page
let root: string
let project: string
let paths: string[]
let original: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-discoverability-')))
  project = join(root, 'project')
  const agentDir = join(root, 'agent')
  const userData = join(root, 'user-data')
  const bucket = join(
    agentDir,
    'sessions',
    `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  await Promise.all([
    mkdir(project),
    mkdir(userData),
    mkdir(join(root, 'home')),
    mkdir(bucket, { recursive: true }),
    mkdir(resolve('artifacts/e2e'), { recursive: true })
  ])
  paths = []
  for (const [index, name] of ['中文设计 Alpha', '第二会话 Beta'].entries()) {
    const date = `2026-09-0${index + 1}T00:00:00.000Z`
    const entries: object[] = [
      { type: 'session', version: 3, id: `saved-${index}`, timestamp: date, cwd: project }
    ]
    let parentId: string | null = null
    for (let n = 0; n < 18; n++) {
      const id = `user-${n}`
      entries.push({
        type: 'message',
        id,
        parentId,
        timestamp: date,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `问题 ${n + 1}：如何定位中文会话？` }],
          timestamp: Date.parse(date) + n * 2
        }
      })
      entries.push({
        type: 'message',
        id: `answer-${n}`,
        parentId: id,
        timestamp: date,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `第 ${n + 1} 个回答。\n\n${'保留原始消息并验证滚动定位。'.repeat(12)}`
            }
          ],
          api: 'openai-responses',
          provider: 'review',
          model: 'fixture',
          stopReason: 'stop',
          timestamp: Date.parse(date) + n * 2 + 1,
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
      parentId = `answer-${n}`
    }
    entries.push({ type: 'session_info', id: 'name', parentId, timestamp: date, name })
    const path = join(bucket, `${date.replaceAll(':', '-').replace('.', '-')}_saved-${index}.jsonl`)
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    paths.push(path)
  }
  original = await readFile(paths[0]!, 'utf8')
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
      PI_DESKTOP_E2E_USER_DATA: userData
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), paths[0]!)
  await expect(page.locator('.conversation-session-title')).toHaveText('中文设计 Alpha')
  const opened = await readFile(paths[0]!, 'utf8')
  expect(opened.startsWith(original)).toBe(true)
  // Pi may append its initial thinking level when opening a fixture. Rename starts here.
  original = opened
})

test.afterEach(async () => {
  if (paths?.[0]) await chmod(paths[0], 0o600).catch(() => {})
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function rename(name: string): Promise<void> {
  await page.getByRole('button', { name: '重命名会话', exact: true }).click()
  await page.getByRole('textbox', { name: '会话名称', exact: true }).fill(name)
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
}

test('real canonical rename updates both titles, survives reopen/reload and only appends session_info', async () => {
  await rename('  新的中文名称 🚀  ')
  await expect(page.locator('.conversation-session-title')).toHaveText('新的中文名称 🚀')
  await expect(page.locator('.session-row.is-active .session-title')).toHaveText('新的中文名称 🚀')
  expect((await page.evaluate(() => window.pi.getState())).activeSessionPath).toBe(paths[0])
  const saved = await readFile(paths[0]!, 'utf8')
  expect(saved.startsWith(original)).toBe(true)
  const added = saved
    .slice(original.length)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ type: 'session_info', name: '新的中文名称 🚀' })
  await page.locator('.session-row').filter({ hasText: '第二会话 Beta' }).click()
  await page.locator('.session-row').filter({ hasText: '新的中文名称 🚀' }).click()
  await page.reload()
  await expect(page.locator('.conversation-session-title')).toHaveText('新的中文名称 🚀')
  await page.screenshot({ path: resolve('artifacts/e2e/session-discoverability.png') })
})

test('real IPC rejects stale session and generation without changing canonical name', async () => {
  const snapshot = await page.evaluate(() => window.pi.getState())
  for (const identity of [
    { sessionId: 'stale-session', generation: snapshot.generation },
    { sessionId: snapshot.sessionId!, generation: snapshot.generation - 1 }
  ]) {
    const error = await page.evaluate(async (identity) => {
      try {
        await window.pi.send({ type: 'session:rename', ...identity, name: '不能保存' })
        return null
      } catch (error) {
        return String(error)
      }
    }, identity)
    expect(error).toBeTruthy()
  }
  expect(await readFile(paths[0]!, 'utf8')).toBe(original)
})

test('global title search supports Chinese, case insensitive matches, focus restoration and project switches', async () => {
  const trigger = page.getByRole('button', { name: '搜索所有会话' })
  await trigger.click()
  const search = page.getByRole('combobox', { name: '搜索所有会话标题' })
  const results = page.locator('[cmdk-item][data-value^="[\\\"session\\\""]')
  await search.fill('ALPHA')
  await expect(results).toHaveCount(1)
  await expect(results).toContainText('中文设计 Alpha')
  await search.fill('第二')
  await expect(results).toHaveCount(1)
  await expect(results).toContainText('第二会话 Beta')
  await search.fill('没有匹配')
  await expect(page.getByText('没有匹配的会话标题', { exact: true })).toBeVisible()
  await search.fill('')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(results).toHaveCount(2)
  await search.fill('ALPHA')
  const other = join(root, 'other-project')
  await mkdir(other)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), other)
  await expect(search).toHaveCount(0)
  await trigger.click()
  await search.fill('ALPHA')
  await expect(results).toHaveCount(1)
  await expect(results).toContainText('中文设计 Alpha')
  await search.fill('')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  await search.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(
    page
      .locator('.project-group')
      .filter({ has: page.getByRole('button', { name: 'other-project', exact: true }) })
  ).toContainText('暂无会话')
})

test('question navigation focuses first/last rows, restores trigger on Escape and fits 960', async () => {
  const trigger = page.getByRole('button', { name: '问题导航', exact: true })
  const rows = page.locator('[data-user-node-id]')
  await trigger.click()
  await page.getByRole('button', { name: '1. 问题 1：如何定位中文会话？', exact: true }).click()
  await expect(rows.first()).toBeFocused()
  await expect(rows.first()).toBeInViewport()
  await trigger.click()
  await page.getByRole('button', { name: '18. 问题 18：如何定位中文会话？', exact: true }).click()
  await expect(rows.last()).toBeFocused()
  await expect(rows.last()).toBeInViewport()
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 760))
  await expect(page.locator('.conversation-head-meta small')).toHaveCSS('max-width', '220px')
  await expect(trigger).toBeInViewport()
  await expect(page.getByRole('button', { name: '重命名会话', exact: true })).toBeInViewport()
  await page.getByRole('button', { name: '重命名会话', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '会话名称', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '重命名会话', exact: true })).toBeFocused()
  await trigger.click()
  await page.screenshot({ path: resolve('artifacts/e2e/session-discoverability-960.png') })
})

test('isolated stream event injection keeps a question selection in history', async () => {
  await page.getByRole('button', { name: '问题导航', exact: true }).click()
  await page.getByRole('button', { name: '1. 问题 1：如何定位中文会话？', exact: true }).click()
  await expect(page.locator('[data-user-node-id]').first()).toBeFocused()
  const scroll = page.locator('.conversation-scroll')
  const top = await scroll.evaluate((element) => element.scrollTop)
  const state = await page.evaluate(() => window.pi.getState())
  state.revision++
  state.busy = true
  state.status = 'running'
  state.nodes.push({
    id: 'stream-fixture',
    type: 'assistant',
    markdown: '隔离注入的流式增量',
    streaming: true
  })
  await app.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
      type: 'event',
      event: 'snapshot',
      data
    })
  }, state)
  await expect(page.getByText('隔离注入的流式增量')).toBeAttached()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(top)
  await expect(page.getByRole('button', { name: '重命名会话', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '回到底部' }).click()
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(top)
})

test('isolated IPC rejection preserves rename input and shows a local error', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle('pi:command', () => {
      throw new Error('隔离测试：保存被拒绝')
    })
  })
  await rename('保留这份名称')
  await expect(page.getByRole('textbox', { name: '会话名称', exact: true })).toHaveValue(
    '保留这份名称'
  )
  await expect(page.locator('.session-rename-error')).toContainText('隔离测试：保存被拒绝')
  await expect(page.locator('.conversation-session-title')).toHaveText('中文设计 Alpha')
  expect(await readFile(paths[0]!, 'utf8')).toBe(original)
})

test('isolated short-tail stream keeps navigation paused even when selected question is near bottom', async () => {
  const state = await page.evaluate(() => window.pi.getState())
  state.nodes = state.nodes.slice(0, -1)
  const publish = async (): Promise<void> => {
    state.revision++
    await app.evaluate(({ BrowserWindow }, data) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
        type: 'event',
        event: 'snapshot',
        data
      })
    }, state)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  }
  await publish()
  await page.locator('.conversation-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
  await page.getByRole('button', { name: '问题导航', exact: true }).click()
  await page.getByRole('button', { name: '18. 问题 18：如何定位中文会话？', exact: true }).click()
  await expect(page.locator('[data-user-node-id]').last()).toBeFocused()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const scroll = page.locator('.conversation-scroll')
  const before = await scroll.evaluate((element) => element.scrollTop)
  state.busy = true
  state.status = 'running'
  state.nodes.push({
    id: 'long-stream',
    type: 'assistant',
    markdown: '流式新增内容。\n\n'.repeat(100),
    streaming: true
  })
  await publish()
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before)
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toHaveCount(0)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  state.nodes.push({
    id: 'resumed-stream',
    type: 'assistant',
    markdown: '手动到底后继续跟随。\n\n'.repeat(30),
    streaming: true
  })
  await publish()
  expect(
    await scroll.evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop
    )
  ).toBeLessThan(80)
})

test('shared validation accepts 80 emoji and rejects empty/overlong names', async () => {
  await rename('   ')
  await expect(page.locator('.session-rename-error')).toContainText('不能为空')
  const input = page.getByRole('textbox', { name: '会话名称', exact: true })
  await input.fill('🚀'.repeat(81))
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.locator('.session-rename-error')).toContainText('80')
  await input.fill('🚀'.repeat(80))
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.locator('.conversation-session-title')).toHaveText('🚀'.repeat(80))
})

test('isolated delayed IPC reply cannot duplicate a save or close a new identity form', async () => {
  const state = await page.evaluate(() => window.pi.getState())
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:command')
    let calls = 0
    ipcMain.handle('pi:command', () => {
      calls++
      return new Promise((_resolve, reject) => {
        ipcMain.once('discoverability:reject', () => reject(new Error(`旧请求失败 ${calls}`)))
      })
    })
  })
  await rename('等待中的名称')
  await expect(page.getByRole('button', { name: '正在保存…' })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: '会话名称', exact: true })).toBeDisabled()
  await page.keyboard.press('Enter')
  const calls = await app.evaluate(({ ipcMain }) => {
    // Read instrumentation through the handler installed only in this isolated process.
    return ipcMain.listenerCount('discoverability:reject')
  })
  expect(calls).toBe(1)
  state.generation++
  state.revision++
  await app.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
      type: 'event',
      event: 'snapshot',
      data
    })
  }, state)
  await expect(page.getByRole('textbox', { name: '会话名称', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '重命名会话', exact: true }).click()
  await page.getByRole('textbox', { name: '会话名称', exact: true }).fill('新代际的名称')
  await app.evaluate(({ ipcMain }) => ipcMain.emit('discoverability:reject'))
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(page.getByRole('textbox', { name: '会话名称', exact: true })).toHaveValue(
    '新代际的名称'
  )
  await expect(page.locator('.session-rename-error')).toHaveCount(0)
  expect(await readFile(paths[0]!, 'utf8')).toBe(original)
})

test('real fixture write failure disconnects without losing messages, explicit reconnect recovers and retry saves', async () => {
  await chmod(paths[0]!, 0o400)
  const writable = await access(paths[0]!, constants.W_OK).then(
    () => true,
    () => false
  )
  test.skip(
    writable,
    'This platform/user can write a readonly fixture; cannot exercise real permission failure.'
  )
  const before = await page.locator('.node-flow').innerText()
  await rename('失败不应保存')
  await expect(page.getByRole('button', { name: '重新连接引擎', exact: true })).toBeVisible()
  await expect(page.locator('.conversation-session-title')).toHaveText('中文设计 Alpha')
  await expect(page.locator('.node-flow')).toHaveText(before, { useInnerText: true })
  expect(await readFile(paths[0]!, 'utf8')).toBe(original)
  await chmod(paths[0]!, 0o600)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '重新连接引擎', exact: true }).click()
  await expect(page.getByRole('button', { name: '重命名会话', exact: true })).toBeEnabled()
  await expect(page.locator('.conversation-session-title')).toHaveText('中文设计 Alpha')
  await rename('恢复后重试')
  await expect(page.locator('.conversation-session-title')).toHaveText('恢复后重试')
  expect((await readFile(paths[0]!, 'utf8')).startsWith(original)).toBe(true)
})
