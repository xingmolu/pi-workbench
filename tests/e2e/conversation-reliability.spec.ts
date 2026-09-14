import { openWorkbenchTool } from './workbench-helpers'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentSnapshot, HostAckResult, PiDesktopAPI } from '../../src/shared/contracts'

declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}

let app: ElectronApplication
let page: Page
let root: string
let state: AgentSnapshot

async function publish(): Promise<void> {
  state.revision++
  await app.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event', {
      type: 'event',
      event: 'snapshot',
      data
    })
  }, state)
  await expect(page.locator('.conversation-head-meta')).toContainText(state.activeModel!)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-reliability-')))
  const agentDir = join(root, 'agent'),
    userData = join(root, 'user-data')
  await mkdir(agentDir)
  await mkdir(userData)
  await mkdir(join(root, 'home'))
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
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
  const initial = await page.evaluate(() => window.pi.getState())
  state = {
    ...initial,
    generation: initial.generation + 100,
    revision: 1,
    sessionId: 'review-a',
    project: { path: root, name: 'Review A' },
    activeProvider: 'review',
    activeModel: 'fixture',
    modelAvailability: 'available',
    composeBlockReason: null,
    accounts: [
      {
        id: 'review',
        name: '隔离测试账号',
        authType: 'api_key',
        connected: true,
        subscription: false,
        alias: false
      }
    ],
    models: [
      {
        provider: 'review',
        id: 'fixture',
        name: '测试模型（无网络）',
        contextWindow: 32000,
        reasoning: false
      }
    ]
  }
  await publish()
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('code block actions preserve exact text and streaming wrap state', async () => {
  const payload = '\tconst value = "' + 'long_value_'.repeat(35) + '";  \n\n'
  const markdown = (text: string) => '行内 `value` 保持原样。\n\n```typescript\n' + text + '\n```'
  state.nodes = [
    { id: 'code-actions', type: 'assistant', markdown: markdown(payload), streaming: true }
  ]
  await publish()
  const copy = page.getByRole('button', { name: '复制代码', exact: true })
  const wrap = page.getByRole('button', { name: '自动换行', exact: true })
  await expect(copy).toBeVisible()
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect(copy).toHaveCount(1)
  await expect(page.locator('.assistant-node p code')).toHaveText('value')
  await expect(page.locator('.assistant-node p')).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.assistant-node p')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await page.evaluate(() => {
    const fixture = { values: [] as string[], mode: 'resolve', finish: null as null | (() => void) }
    Object.assign(window, { codeClipboardFixture: fixture })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          fixture.values.push(value)
          if (fixture.mode === 'reject') return Promise.reject(new Error('fixture denied'))
          if (fixture.mode === 'delay')
            return new Promise<void>((resolve) => {
              fixture.finish = resolve
            })
          return Promise.resolve()
        }
      }
    })
  })
  const pre = page.locator('.code-block pre')
  await expect(pre).toHaveCSS('white-space', 'pre')
  await pre.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await wrap.focus()
  await page.keyboard.press('Space')
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await copy.click()
  await expect(page.getByRole('status').filter({ hasText: '代码已复制' })).toHaveText('代码已复制')
  const fixture = () =>
    page.evaluate(
      () =>
        (window as unknown as { codeClipboardFixture: { values: string[] } }).codeClipboardFixture
          .values
    )
  expect(await fixture()).toEqual([payload])
  state.nodes = [
    { id: 'code-actions', type: 'assistant', markdown: markdown(payload + 'next'), streaming: true }
  ]
  await publish()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect(copy).toBeVisible()
  await page.screenshot({ path: 'artifacts/e2e/code-block-actions.png' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 800))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960)
  await expect(pre).toHaveCSS('white-space', 'pre-wrap')
  expect(await pre.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  await page.screenshot({ path: 'artifacts/e2e/code-block-actions-960.png' })
  await page.evaluate(() => {
    ;(window as unknown as { codeClipboardFixture: { mode: string } }).codeClipboardFixture.mode =
      'reject'
  })
  await copy.click()
  await expect(page.getByRole('status').filter({ hasText: '复制失败' })).toBeVisible()
  expect(await pre.evaluate((element) => getComputedStyle(element).userSelect)).not.toBe('none')
  await page.evaluate(() => {
    ;(window as unknown as { codeClipboardFixture: { mode: string } }).codeClipboardFixture.mode =
      'delay'
  })
  await copy.click()
  await expect(copy).toBeDisabled()
  expect((await fixture()).length).toBe(3)
  state.nodes = [
    { id: 'code-actions', type: 'assistant', markdown: markdown('changed'), streaming: true }
  ]
  await publish()
  await page.evaluate(() => {
    ;(
      window as unknown as { codeClipboardFixture: { finish: () => void } }
    ).codeClipboardFixture.finish()
  })
  await expect(copy).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '代码已复制' })).toHaveCount(0)
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await copy.click()
  state.nodes = []
  await publish()
  await page.evaluate(() => {
    ;(
      window as unknown as { codeClipboardFixture: { finish: () => void } }
    ).codeClipboardFixture.finish()
  })
  state.nodes = [{ id: 'replacement', type: 'assistant', markdown: '```\nfresh\n```' }]
  await publish()
  await expect(copy).toBeVisible()
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.code-block-language')).toHaveText('代码')
  state.nodes = [
    {
      id: 'long-language',
      type: 'assistant',
      markdown: '```' + 'language'.repeat(80) + '\ntext\n```'
    }
  ]
  await publish()
  await expect(page.locator('.code-block-language')).toHaveCSS('text-overflow', 'ellipsis')
  await expect(copy).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test('one provider failure is shown once without hiding a distinct client failure', async () => {
  state.nodes = [1, 2, 3].map((attempt) => ({
    id: `failure-${attempt}`,
    type: 'error',
    message: '模型服务拒绝请求'
  }))
  state.error = '模型服务拒绝请求'
  state.status = 'error'
  await publish()
  await expect(page.getByText('模型服务拒绝请求', { exact: true })).toHaveCount(1)
  state.error = '网络已断开'
  await publish()
  await expect(page.getByText('网络已断开', { exact: true })).toBeVisible()
})

test('pending browser approval has a visible keyboard-accessible jump and concise summary', async () => {
  state.nodes = Array.from({ length: 60 }, (_, index) => ({
    id: `history-${index}`,
    type: 'assistant' as const,
    markdown: `历史段落 ${index}`
  }))
  await publish()
  await page.locator('.conversation-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
  state.nodes.push({
    id: 'tool-browser',
    type: 'tool',
    toolCallId: 'browser-1',
    name: 'browser',
    title: '浏览器 · new_tab',
    intent: 'web',
    status: 'awaiting-approval'
  })
  state.approvals = [
    {
      id: 'approval-browser',
      generation: state.generation,
      toolCallId: 'browser-1',
      toolName: 'browser',
      intent: 'web',
      title: '浏览器 · new_tab',
      detail: JSON.stringify({ action: 'new_tab', url: 'https://example.com' })
    }
  ]
  state.status = 'awaiting-approval'
  state.busy = true
  await publish()
  const jump = page.getByRole('button', { name: /查看待确认操作/ })
  await expect(jump).toBeInViewport()
  await jump.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toBeInViewport()
  await expect(page.locator('.approval-card')).toContainText('example.com')
  await expect(page.locator('.approval-card')).not.toContainText('写文件和运行命令前')
})

test('restored Pi aborted message is stopped, not an error, and keeps partial output', async () => {
  const sessionDir = join(
    root,
    'agent',
    'sessions',
    `--${root.replace(/^\//, '').replaceAll('/', '-')}--`
  )
  await mkdir(sessionDir, { recursive: true })
  const date = '2026-09-11T00:00:00.000Z'
  const path = join(sessionDir, '2026-09-11T00-00-00-000Z_stopped.jsonl')
  await writeFile(
    path,
    [
      { type: 'session', version: 3, id: 'stopped', timestamp: date, cwd: root },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: date,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '停止测试' }],
          timestamp: Date.parse(date)
        }
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: date,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '保留部分输出' }],
          api: 'openai-responses',
          provider: 'review',
          model: 'fixture',
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
          timestamp: Date.parse(date) + 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  )
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), root)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), path)
  const restored = await page.evaluate(() => window.pi.getState())
  expect(restored.nodes).toContainEqual(
    expect.objectContaining({ type: 'assistant', markdown: '保留部分输出' })
  )
  expect(restored.nodes.some((node) => node.type === 'error')).toBe(false)
  expect(restored.status).toBe('stopped')
  // Drop the deliberately newer renderer fixture generation before observing the real Host.
  await page.reload()
  await expect(page.locator('.conversation-status')).toHaveText('已停止')
})

test('rejected models are disabled while another model can be chosen without opening settings', async () => {
  state.models = [
    { ...state.models[0]!, unavailableReason: '当前账号不支持此模型' },
    { ...state.models[0]!, id: 'usable', name: '可用测试模型' }
  ]
  state.modelAvailability = 'unavailable'
  state.composeBlockReason = 'pinned-model-unavailable'
  state.nodes = [{ id: 'old-answer', type: 'assistant', markdown: '之前的对话仍在' }]
  await publish()
  await page.getByRole('button', { name: /此会话模型不可用/ }).click()
  await expect(page.getByRole('menuitem', { name: /测试模型（无网络）/ })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: /可用测试模型/ })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByText('之前的对话仍在')).toBeVisible()
})

test('table layout, header metadata and interrupted usage stay readable in a narrow window', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 760))
  state.activeModel = 'gpt-5.6-sol'
  state.activeSessionPath = '/review.jsonl'
  state.sessions = [
    {
      id: 'review-a',
      path: '/review.jsonl',
      title: '非常长的会话标题'.repeat(30),
      modified: '2026-09-11',
      messageCount: 2,
      active: true,
      status: 'stopped'
    }
  ]
  state.nodes = [
    {
      id: 'table',
      type: 'assistant',
      markdown: '|测试项|状态|\n|---|---|\n|登录|通过|\n|对话|通过|'
    },
    { id: 'think', type: 'think', text: '**Planning something**' },
    { id: 'stopped', type: 'stopped', message: '已停止生成，可继续对话' }
  ]
  state.metrics = {
    ...state.metrics,
    turns: 1,
    output: 0,
    llmDurationMs: 2000,
    tokensPerSecond: 0,
    usageIncomplete: true
  }
  await publish()
  const cell = page.locator('.markdown-table td').first()
  expect(
    await cell.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft))
  ).toBeGreaterThanOrEqual(12)
  const meta = page.locator('.conversation-head-meta small')
  await expect(meta).toBeHidden()
  await expect(page.locator('.conversation-status')).toBeInViewport()
  expect(
    await page
      .locator('.conversation-head')
      .evaluate((element) => element.getBoundingClientRect().height)
  ).toBe(48)
  await page.locator('.work-summary-trigger').click()
  await expect(page.getByRole('button', { name: '思考了一会儿', exact: true })).toBeVisible()
  await expect(page.locator('.composer-stats')).toContainText('中断用量未知')
  await expect(page.locator('.composer-stats')).not.toContainText('0 tok/s')
  await page.screenshot({ path: resolve('artifacts/e2e/fixed-reading-960.png') })
})

test('narrow composer keeps account and model readable with the workbench and queue open', async () => {
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# Layout fixture\n')
  const opened = await page.evaluate(
    (cwd) => window.pi.send({ type: 'project:open', cwd }),
    project
  )
  state.desktopScope = opened.snapshot.desktopScope
  state.project = { path: project, name: '界面验收' }
  state.accounts[0].name = '工作 Codex'
  state.models[0].name = 'GPT-5.6 Sol'
  state.followUp = ['检查测试覆盖', '整理修改说明']
  state.nodes = [
    { id: 'layout-question', type: 'user', text: '帮我检查这份修改，保留现有交互。' },
    {
      id: 'layout-answer',
      type: 'assistant',
      markdown: '我会先检查改动，再验证关键交互。你可以在右侧查看项目文件。'
    }
  ]
  await publish()
  await openWorkbenchTool(page, '文件')
  await page.getByRole('textbox', { name: '给 Pi 的任务' }).fill('继续检查边界情况')
  for (const width of [960, 1240, 1440]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
      width
    )
    const account = page.locator('.composer .account-chip')
    const model = page.getByRole('button', { name: '选择模型', exact: true })
    await expect(account).toBeInViewport()
    await expect(model).toBeInViewport()
    for (const label of [account.locator('span'), model.locator('span')]) {
      // Assert actual label legibility, not a minimum wider than a short name.
      expect(await label.evaluate((el) => el.clientWidth >= el.scrollWidth)).toBe(true)
    }
    await model.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem').filter({ hasText: 'GPT-5.6 Sol' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(model).toBeFocused()
    await page.getByRole('button', { name: '添加文本文件', exact: true }).focus()
    for (const control of [
      page.locator('.composer .permission-chip'),
      account,
      model,
      page.locator('.composer .context-meter'),
      page.locator('.composer .queue-button'),
      page.locator('.composer .send')
    ]) {
      await page.keyboard.press('Tab')
      await expect(control).toBeFocused()
    }
    await expect(
      page.getByRole('button', { name: '查看待发送队列，共 2 条', exact: true })
    ).toBeInViewport()
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: resolve(`artifacts/e2e/composer-layout-${width}.png`) })
  }
})

test('drafts stay with their session and survive model changes', async () => {
  const input = page.getByRole('textbox', { name: '给 Pi 的任务' })
  await input.fill('会话 A 的草稿')
  state.sessionId = 'review-b'
  state.generation++
  await publish()
  await expect(input).toHaveValue('')
  await input.fill('会话 B 的草稿')
  state.sessionId = 'review-a'
  state.generation++
  await publish()
  await expect(input).toHaveValue('会话 A 的草稿')
  state.activeModel = 'other'
  state.generation++
  await publish()
  await expect(input).toHaveValue('会话 A 的草稿')
})

test('rejected send preserves the draft and offers understandable feedback', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle('pi:command', () => {
      throw new Error('模拟发送失败')
    })
  })
  const input = page.getByRole('textbox', { name: '给 Pi 的任务' })
  await input.fill('发送失败后保留')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(page.locator('.client-error')).toContainText('模拟发送失败')
  await expect(input).toHaveValue('发送失败后保留')
  await expect(page.locator('.client-error')).not.toContainText('Error invoking remote method')
  await page.screenshot({ path: 'artifacts/e2e/fixed-send-rejection.png' })
})

test('streaming respects a reader who scrolled up', async () => {
  state.busy = true
  state.status = 'running'
  state.nodes = Array.from({ length: 50 }, (_, i) => ({
    id: `a-${i}`,
    type: 'assistant',
    markdown: `第 ${i} 段\n\n用于验证阅读位置的内容。`
  }))
  await publish()
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await scroll.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  state.nodes.push({ id: 'new', type: 'assistant', markdown: '新到达的流式内容' })
  await publish()
  await expect(page.getByText('新到达的流式内容', { exact: true })).toBeAttached()
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0)
  await page.screenshot({ path: 'artifacts/e2e/fixed-reading-position.png' })
  await page.getByRole('button', { name: '回到底部' }).click()
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('late send acceptance cannot clear a newer edit or another session draft', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:command')
    ipcMain.handle(
      'pi:command',
      () =>
        new Promise((resolve) => {
          ipcMain.once('review:accept', () => resolve({ kind: 'ack' }))
        })
    )
  })
  const input = page.getByRole('textbox', { name: '给 Pi 的任务' })
  await input.fill('旧版本')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(input).toHaveValue('旧版本')
  await input.fill('新版本')
  state.sessionId = 'review-b'
  state.generation++
  await publish()
  await input.fill('另一个会话')
  await app.evaluate(({ ipcMain }) => ipcMain.emit('review:accept'))
  await expect(input).toHaveValue('另一个会话')
  state.sessionId = 'review-a'
  state.generation++
  await publish()
  await expect(input).toHaveValue('新版本')
})

test('host exit revokes readiness and allows explicit recovery', async () => {
  const opened = await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), root)
  state.sessionId = opened.snapshot.sessionId
  state.activeSessionPath = opened.snapshot.activeSessionPath
  state.desktopScope = opened.snapshot.desktopScope
  state.generation++
  await publish()
  await page.getByRole('textbox', { name: '给 Pi 的任务' }).fill('重连后仍能取回的草稿')
  const pid = await app.evaluate(
    ({ app }, workerId) =>
      app.getAppMetrics().find((m) => m.name === `Pi Session Host ${workerId}`)?.pid,
    opened.snapshot.desktopScope!.workerId
  )
  expect(pid).toBeDefined()
  await app.evaluate(({}, pid) => process.kill(pid!, 'SIGKILL'), pid)
  await expect(page.getByText('Pi 引擎已就绪', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务' })).toBeDisabled()
  await page.screenshot({ path: 'artifacts/e2e/fixed-host-disconnected.png' })
  await page.getByRole('button', { name: '重新连接引擎' }).click()
  await expect(page.getByText('Pi 引擎已就绪', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  expect(await page.evaluate(async () => (await window.pi.getState()).project?.path)).toBe(root)
  await expect(page.getByRole('textbox', { name: '给 Pi 的任务' })).toHaveValue(
    '重连后仍能取回的草稿'
  )
})

test('accepted send clears only its submitted draft', async () => {
  await app.evaluate(
    ({ ipcMain }, identity) => {
      ipcMain.removeHandler('pi:command')
      ipcMain.handle('pi:command', () => ({ kind: 'ack', ...identity }) satisfies HostAckResult)
    },
    { sessionId: state.sessionId, generation: state.generation, revision: state.revision }
  )
  const input = page.getByRole('textbox', { name: '给 Pi 的任务' })
  await input.fill('已接收的草稿')
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect(input).toHaveValue('')
})

test('reconnection restores the selected persisted session, not the most recent one', async () => {
  const bucket = join(
    root,
    'agent',
    'sessions',
    `--${root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  )
  await mkdir(bucket, { recursive: true })
  const olderPath = join(bucket, '2026-09-01T00-00-00-000Z_older.jsonl')
  for (const [path, id, date] of [
    [olderPath, 'older', '2026-09-01T00:00:00.000Z'],
    [join(bucket, '2026-09-02T00-00-00-000Z_newer.jsonl'), 'newer', '2026-09-02T00:00:00.000Z']
  ]) {
    await writeFile(
      path!,
      [
        { type: 'session', version: 3, id, timestamp: date, cwd: root },
        {
          type: 'message',
          id: 'user-1',
          parentId: null,
          timestamp: date,
          message: {
            role: 'user',
            content: [{ type: 'text', text: `记录 ${id}` }],
            timestamp: Date.parse(date!)
          }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n'
    )
  }
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), root)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), olderPath)
  const selected = await page.evaluate(() => window.pi.getState())
  const pid = await app.evaluate(
    ({ app }, workerId) =>
      app.getAppMetrics().find((m) => m.name === `Pi Session Host ${workerId}`)?.pid,
    selected.desktopScope!.workerId
  )
  expect(pid).toBeDefined()
  await app.evaluate(({}, pid) => process.kill(pid!, 'SIGKILL'), pid)
  await expect(page.getByRole('button', { name: '重新连接引擎' })).toBeVisible()
  await page.getByRole('button', { name: '重新连接引擎' }).click()
  await expect(page.getByText('Pi 引擎已就绪', { exact: true })).toBeVisible()
  const restored = await page.evaluate(() => window.pi.getState())
  expect(restored.activeSessionPath).toBe(olderPath)
  expect(restored.nodes).toContainEqual(
    expect.objectContaining({ type: 'user', text: '记录 older' })
  )
})
