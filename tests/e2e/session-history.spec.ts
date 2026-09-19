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

declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}

const provider = 'canonical-fixture'
const repeatedToolId = 'reused-tool-id'.repeat(100)
const longProvider = `历史供应商-${'provider'.repeat(18)}`
const longModel = `历史模型-${'model'.repeat(24)}`
const date = '2026-09-11T00:00:00.000Z'
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
let app: ElectronApplication
let page: Page
let root: string
let project: string
let path: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-session-history-')))
  project = join(root, 'project')
  const agentDir = join(root, 'agent')
  const bucket = join(
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
  const entries: object[] = [
    { type: 'session', version: 3, id: 'canonical-history', timestamp: date, cwd: project }
  ]
  let parentId: string | null = null
  const append = (entry: { id: string; [key: string]: unknown }) => {
    entries.push({ timestamp: date, parentId, ...entry })
    parentId = entry.id
  }
  const question = (id: string, text: string) =>
    append({
      type: 'message',
      id,
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(date) }
    })
  const answer = (id: string, text: string) =>
    append({
      type: 'message',
      id,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.parse(date),
        api: 'canonical-fixture-api',
        provider,
        model: 'a',
        stopReason: 'stop',
        usage
      }
    })
  append({ type: 'model_change', id: 'model-old', provider: longProvider, modelId: longModel })
  question('question-one', '第一个同刻问题：保留压缩前的讨论')
  answer('answer-one', '第一段历史回答，应该始终可见。')
  const fork = parentId
  question('alternate-question', '旁支问题绝不能显示')
  answer('alternate-answer', '旁支回答绝不能显示')
  parentId = fork
  append({ type: 'model_change', id: 'model-current', provider, modelId: 'a' })
  question('question-two', '第二个同刻问题：核对模型切换的位置')
  answer('answer-two', '第二段历史回答，使用新的模型。')
  append({
    type: 'compaction',
    id: 'compact',
    firstKeptEntryId: 'question-two',
    summary: '内部压缩摘要绝不能冒充助手回答',
    tokensBefore: 1234
  })
  question('question-three', '第三个同刻问题：从压缩边界继续')
  answer('answer-three', '第三段历史回答，旧问题仍可定位。')
  append({ type: 'session_info', id: 'history-name', name: '会话历史验收' })
  path = join(bucket, '2026-09-11T00-00-00-000Z_canonical-history.jsonl')
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ [provider]: { type: 'api_key', key: 'offline-fixture-only' } })
  )
  await writeFile(join(agentDir, 'models.json'), '{"providers":{}}')
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const aiPackage = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, aiPackage.exports['.'].import)
  await writeFile(
    join(agentDir, 'extensions', 'canonical-fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider: '${provider}', api: 'canonical-fixture-api', models: [{id:'a',reasoning:true},{id:'b',reasoning:true}], tokensPerSecond: 35, tokenSize: {min: 2, max: 2} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('fixture-stream', {description:'Queue offline streaming fixture', handler: async () => {
        faux.setResponses([fauxAssistantMessage([fauxThinking('逐步检查历史与模型位置。'.repeat(12)), fauxText('离线流式回答完成，内容已经保存。')])]);
      }});
      pi.registerCommand('fixture-tools', {description:'Queue offline write fixtures', handler: async () => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall('write', {path:${JSON.stringify(join(project, 'first.txt'))}, content:'first fixture'}, {id:${JSON.stringify(repeatedToolId)}}), {stopReason:'toolUse'}),
          fauxAssistantMessage('第一次写入完成。'),
          fauxAssistantMessage(fauxToolCall('write', {path:${JSON.stringify(join(project, 'second.txt'))}, content:'second fixture'}, {id:${JSON.stringify(repeatedToolId)}}), {stopReason:'toolUse'}),
          fauxAssistantMessage('第二次写入完成。')
        ]);
      }});
    }
  `
  )
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
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
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.pi.getState()).models.filter((m) => m.provider === 'canonical-fixture')
            .length
      )
    )
    .toBe(2)
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), path)
  await expect(page.locator('.conversation-session-title')).toHaveText('会话历史验收')
  // The history title may paint before the new resident's extension model catalog is ready.
  await expect.poll(() => page.evaluate(async () => {
    const state = await window.pi.getState()
    return { sessionId: state.sessionId, model: state.activeModel, availability: state.modelAvailability }
  })).toEqual({ sessionId: 'canonical-history', model: 'a', availability: 'available' })
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('canonical branch keeps same-time questions, model positions and compaction history readable after reopen', async () => {
  const flow = page.locator('.node-flow')
  await expect(flow.locator('.user-row')).toHaveCount(3)
  await expect(flow).not.toContainText('旁支')
  await expect(flow).not.toContainText('内部压缩摘要')
  const expected = [
    'model',
    'user',
    'assistant',
    'model',
    'user',
    'assistant',
    'compaction',
    'user',
    'assistant'
  ]
  const state = await page.evaluate(() => window.pi.getState())
  expect(state.nodes.map((n) => n.type)).toEqual(expected)
  expect(new Set(state.nodes.filter((n) => n.type === 'user').map((n) => n.id)).size).toBe(3)
  await expect(flow.locator('.history-note')).toHaveCount(2)
  await expect(flow.locator('.history-note').first()).toHaveText(`模型切换 · ${provider} / a`)
  await expect(flow.locator('.history-note').nth(1)).toHaveText('上下文已压缩，历史消息仍保留')
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => flow.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    const notes = await flow.locator('.history-note').evaluateAll((elements) =>
      elements.map((el) => ({
        tabIndex: (el as HTMLElement).tabIndex,
        controls: el.querySelectorAll('button,a,input,[tabindex],img,time').length,
        fontSize: getComputedStyle(el).fontSize,
        border: getComputedStyle(el).borderTopWidth
      }))
    )
    expect(notes.every((note) => note.tabIndex === -1 && note.controls === 0)).toBe(true)
    expect(notes.every((note) => note.fontSize === '12px' && note.border === '0px')).toBe(true)
    const contrast = await flow
      .locator('.history-note')
      .first()
      .evaluate((el) => {
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const channel = v / 255
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
            })
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        const foreground = luminance(getComputedStyle(el).color)
        const background = luminance(getComputedStyle(document.body).backgroundColor)
        return (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
      })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    for (const [index, question] of [
      [1, '第二个同刻问题：核对模型切换的位置'],
      [2, '第三个同刻问题：从压缩边界继续'],
      [0, '第一个同刻问题：保留压缩前的讨论']
    ] as const) {
      await page.getByRole('button', { name: '问题导航', exact: true }).click()
      await page.getByRole('button', { name: `${index + 1}. ${question}`, exact: true }).click()
      await expect(flow.locator('.user-row').nth(index)).toBeFocused()
    }
    await page.screenshot({
      path: resolve(`artifacts/e2e/session-history${width === 960 ? '-960' : ''}.png`)
    })
  }
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), path)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).nodes))
    .toEqual(state.nodes)
  await expect(flow.locator('.user-row')).toHaveCount(3)
})

test('real model:set appends model history without replacing the session, transcript or draft', async () => {
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.fill('模型切换期间保留的草稿')
  const before = await page.evaluate(() => window.pi.getState())
  const bytes = await readFile(path, 'utf8')
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'canonical-fixture', modelId: 'b' })
  )
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeModel))
    .toBe('b')
  const after = await page.evaluate(() => window.pi.getState())
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.generation).toBe(before.generation)
  expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes)
  expect(after.nodes.at(-1)).toMatchObject({
    type: 'model',
    provider,
    modelId: 'b',
    initial: false
  })
  await expect(draft).toHaveValue('模型切换期间保留的草稿')
  const saved = await readFile(path, 'utf8')
  expect(saved.startsWith(bytes)).toBe(true)
  expect(
    saved
      .slice(bytes.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  ).toEqual([expect.objectContaining({ type: 'model_change', provider, modelId: 'b' })])
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), path)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).nodes))
    .toEqual(after.nodes)
  await expect(page.locator('.history-note').last()).toHaveText(`模型切换 · ${provider} / b`)
})

test('actual offline SDK streaming reconciles canonical IDs while an expanded thought remains open', async () => {
  await page.locator('.node-flow').evaluate((el) => {
    const probe = {
      minimumQuestions: el.querySelectorAll('.user-row').length,
      observer: new MutationObserver(() => {
        probe.minimumQuestions = Math.min(
          probe.minimumQuestions,
          el.querySelectorAll('.user-row').length
        )
      })
    }
    probe.observer.observe(el, { childList: true, subtree: true })
    Object.assign(el, { historyProbe: probe })
  })
  await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({
      type: 'prompt:send',
      text: '/fixture-stream',
      sessionId: sessionId!,
      generation
    })
  })
  await page.getByRole('textbox', { name: '给 Pi 的任务', exact: true }).fill('请运行离线流式回答')
  await page.getByRole('textbox', { name: '给 Pi 的任务', exact: true }).press('Enter')
  const thought = page.locator('.think-node').last()
  await page.locator('.work-summary-trigger').last().click()
  await expect(thought.getByRole('button')).toHaveText('正在思考…')
  await thought.getByRole('button').click()
  await expect(thought.locator('.think-content')).toBeVisible()
  const streaming = await page.evaluate(() => window.pi.getState())
  expect(streaming.nodes.some((n) => n.type === 'think' && n.id.startsWith('temporary:'))).toBe(
    true
  )
  await expect(page.locator('.assistant-node').last()).toContainText(
    '离线流式回答完成，内容已经保存。'
  )
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(thought.locator('.think-content')).toBeVisible()
  const complete = await page.evaluate(() => window.pi.getState())
  const minimumQuestions = await page.locator('.node-flow').evaluate((el) => {
    const probe = (
      el as HTMLElement & { historyProbe: { minimumQuestions: number; observer: MutationObserver } }
    ).historyProbe
    probe.observer.disconnect()
    return probe.minimumQuestions
  })
  expect(minimumQuestions).toBe(3)
  expect(complete.nodes.every((n) => n.id.startsWith('entry:'))).toBe(true)
  expect(complete.nodes.filter((n) => n.type === 'think').at(-1)?.presentationIdentity).toBe(
    streaming.nodes.find((n) => n.type === 'think')?.presentationIdentity
  )
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'canonical-fixture', modelId: 'b' })
  )
  await expect(page.locator('.history-note').last()).toHaveText('模型切换 · canonical-fixture / b')
  await expect(thought.locator('.think-content')).toBeVisible()
  const refreshed = await page.evaluate(() => window.pi.getState())
  expect(refreshed.nodes.filter((n) => n.type === 'think').at(-1)?.presentationIdentity).toBe(
    complete.nodes.filter((n) => n.type === 'think').at(-1)?.presentationIdentity
  )
  await page.screenshot({ path: resolve('artifacts/e2e/session-history-streaming.png') })
  const saved = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const final = saved
    .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
    .at(-1)
  expect(await readFile(path, 'utf8')).not.toContain('presentationIdentity')
  expect(final.message.content).toEqual([
    expect.objectContaining({ type: 'thinking', thinking: '逐步检查历史与模型位置。'.repeat(12) }),
    expect.objectContaining({ type: 'text', text: '离线流式回答完成，内容已经保存。' })
  ])
  expect(complete.nodes.filter((n) => n.type === 'think').at(-1)?.id).toBe(
    `entry:${final.id}:think:0`
  )
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), path)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).nodes))
    // Reopening a resident worker retains its presentation identity; disk assertions above
    // still ensure those ephemeral identifiers never leak into canonical history.
    .toEqual(refreshed.nodes)
})

test('real first model append failure disconnects and retains the last canvas and draft until explicit recovery', async () => {
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.fill('失败后仍保留，不要自动重发')
  const before = await page.evaluate(() => window.pi.getState())
  const canvas = await page.locator('.node-flow').innerText()
  const bytes = await readFile(path, 'utf8')
  const backup = `${path}.fixture-backup`
  await rename(path, backup)
  try {
    // Obstruct only this private fixture's exact transcript. No SDK method interception.
    await mkdir(path)
    const error = await page.evaluate(async () => {
      try {
        await window.pi.send({ type: 'model:set', providerId: 'canonical-fixture', modelId: 'b' })
        return null
      } catch (error) {
        return String(error)
      }
    })
    expect(error).not.toBeNull()
    await expect(page.getByRole('button', { name: '重新连接引擎', exact: true })).toBeVisible()
    await expect(page.locator('.node-flow')).toHaveText(canvas, { useInnerText: true })
    await expect(draft).toHaveValue('失败后仍保留，不要自动重发')
    // The failed session worker is detached, but the independent lobby Host stays available.
    // The renderer must retain the failed canvas/draft until the explicit reconnect below.
    await expect(page.evaluate(() => window.pi.getState())).resolves.toMatchObject({
      project: null, sessionId: null, nodes: [], busy: false
    })
    expect(await readFile(backup, 'utf8')).toBe(bytes)
    await page.screenshot({ path: resolve('artifacts/e2e/session-history-write-failure.png') })
  } finally {
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
  }
  const disk = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(disk.filter((entry) => entry.type === 'model_change').at(-1)).toMatchObject({
    provider,
    modelId: 'a'
  })
  await page.getByRole('button', { name: '重新连接引擎', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).activeModel))
    .toBe('a')
  await expect(draft).toHaveValue('失败后仍保留，不要自动重发')
  const recovered = await page.evaluate(() => window.pi.getState())
  expect(recovered.sessionId).toBe(before.sessionId)
  expect(recovered.nodes).toEqual(before.nodes)
  expect(recovered.busy).toBe(false)
  expect(recovered.followUp).toEqual([])
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'canonical-fixture', modelId: 'b' })
  )
  await expect(page.locator('.history-note').last()).toHaveText(`模型切换 · ${provider} / b`)
  const retried = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(retried.filter((entry) => entry.type === 'model_change').at(-1)).toMatchObject({
    provider,
    modelId: 'b'
  })
})

test('actual SDK reused tool IDs keep the first result intact and show only the current Ask approval', async () => {
  await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({
      type: 'prompt:send',
      text: '/fixture-tools',
      sessionId: sessionId!,
      generation
    })
  })
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.fill('写入第一个离线文件')
  await draft.press('Enter')
  await page.locator('.work-summary-trigger').first().click()
  const firstTool = page.locator('.tool-node').first()
  await expect(firstTool).toBeVisible()
  const streamingTool = (await page.evaluate(() => window.pi.getState())).nodes.find(
    (n) => n.type === 'tool'
  )!
  expect(streamingTool.id).toMatch(/^temporary:/)
  expect(streamingTool.presentationIdentity!.length).toBeLessThanOrEqual(1024)
  await expect(firstTool.locator('.approval-card')).toBeVisible()
  await expect(page.locator('.approval-card')).toHaveCount(1)
  await expect(page.locator('.approval-card')).toContainText('first.txt')
  await page
    .locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true })
    .click()
  await expect(page.locator('.assistant-node').last()).toContainText('第一次写入完成。')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  expect(await readFile(join(project, 'first.txt'), 'utf8')).toBe('first fixture')
  const first = (await page.evaluate(() => window.pi.getState())).nodes.find(
    (n) => n.type === 'tool'
  )!
  expect(first).toMatchObject({ type: 'tool', toolCallId: repeatedToolId, status: 'success' })
  expect(first.presentationIdentity).toBe(streamingTool.presentationIdentity)
  await expect(page.locator('.tool-node').first().locator('.tool-output')).toBeVisible()
  const firstOutput = await page.locator('.tool-node').first().locator('.tool-output').innerText()
  await draft.fill('写入第二个离线文件')
  await draft.press('Enter')
  await expect(page.locator('.approval-card')).toHaveCount(1)
  await expect(page.locator('.approval-card')).toContainText('second.txt')
  await expect(page.locator('.tool-node').first().locator('.tool-output')).toHaveText(firstOutput, {
    useInnerText: true
  })
  const waiting = (await page.evaluate(() => window.pi.getState())).nodes.filter(
    (n) => n.type === 'tool'
  )
  expect(waiting).toHaveLength(2)
  expect(waiting[0]).toEqual(first)
  expect(waiting[1]).toMatchObject({ toolCallId: repeatedToolId, status: 'awaiting-approval' })
  expect(waiting[1].id).not.toBe(first.id)
  await page.screenshot({ path: resolve('artifacts/e2e/session-history-approval.png') })
  await page
    .locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true })
    .click()
  await expect(page.locator('.assistant-node').last()).toContainText('第二次写入完成。')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  expect(await readFile(join(project, 'second.txt'), 'utf8')).toBe('second fixture')
  const complete = (await page.evaluate(() => window.pi.getState())).nodes.filter(
    (n) => n.type === 'tool'
  )
  expect(complete[0]).toEqual(first)
  expect(complete[1]).toMatchObject({ status: 'success' })
  const saved = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const calls = saved
    .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
    .flatMap((entry) => entry.message.content.filter((block) => block.type === 'toolCall'))
  const results = saved.filter(
    (entry) => entry.type === 'message' && entry.message.role === 'toolResult'
  )
  expect(calls.map((call) => [call.id, call.arguments.path])).toEqual([
    [repeatedToolId, join(project, 'first.txt')],
    [repeatedToolId, join(project, 'second.txt')]
  ])
  expect(results.map((entry) => entry.message.toolCallId)).toEqual([repeatedToolId, repeatedToolId])
  expect(results.map((entry) => entry.message.content[0].text)).toEqual(
    complete.map((n) => (n.type === 'tool' ? n.output : ''))
  )
  await page.evaluate((path) => window.pi.send({ type: 'session:open', path }), path)
  const reopened = (await page.evaluate(() => window.pi.getState())).nodes.filter(
    (n) => n.type === 'tool'
  )
  expect(reopened.map((n) => [n.id, n.status, n.output])).toEqual(
    complete.map((n) => [n.id, n.status, n.output])
  )
})
