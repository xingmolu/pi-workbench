import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { MobileGatewayServer, type MobileViewsBridge } from '../../src/main/mobile-gateway'
import { MobilePairingStore } from '../../src/main/mobile-pairing'
import { MobilePluginViews } from '../../src/main/mobile-plugin-views'
import { PluginApiError } from '../../src/shared/plugin-api'
import type { MobileSessionBridge } from '../../src/main/mobile-session-bridge'
import type {
  MobileConversationSnapshot,
  PairedDeviceRecord
} from '../../src/shared/mobile-gateway'

let app: ElectronApplication | undefined
let gateway: MobileGatewayServer | undefined
let root: string | undefined

test.afterEach(async () => {
  await app?.close()
  await gateway?.stop()
  if (root) await rm(root, { recursive: true, force: true })
  app = undefined
  gateway = undefined
  root = undefined
})

async function launchMobile(
  initial = 'initial-state',
  failHttpSnapshot = false,
  maxFrameBytes = 1024,
  views?: MobileViewsBridge
) {
  root = await mkdtemp(join(tmpdir(), 'pi-mobile-delivery-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  let current: MobileConversationSnapshot = {
    workerId: 'worker-1',
    cwd: '/fixture',
    title: 'Delivery fixture',
    sessionId: 'session-1',
    generation: 1,
    revision: 1,
    status: 'idle',
    busy: false,
    approvals: [],
    followUp: [],
    queuedCount: 0,
    composeBlockReason: null,
    nodes: [{ id: 'reply', type: 'assistant', markdown: initial }]
  }
  let publish: Parameters<MobileSessionBridge['subscribe']>[0] = () => undefined
  const paths: string[] = []
  const responses: { approvalId: string; allow: boolean }[] = []
  const calls: Record<string, unknown>[] = []
  let requestPath = ''
  let devices: PairedDeviceRecord[] = []
  const pairing = new MobilePairingStore({
    load: () => devices,
    save: (saved) => {
      devices = saved
    }
  })
  const sessions: MobileSessionBridge = {
    listLive: () => [
      {
        workerId: current.workerId,
        cwd: current.cwd,
        sessionId: current.sessionId,
        sessionPath: '/fixture/session.jsonl',
        generation: current.generation,
        status: 'idle',
        selected: true,
        title: current.title
      },
      {
        workerId: 'unavailable-worker',
        cwd: '/fixture',
        sessionId: 'unavailable-session',
        sessionPath: '/fixture/unavailable.jsonl',
        generation: 1,
        status: 'idle',
        selected: false,
        title: 'Unavailable session'
      }
    ],
    listCatalog: async () => [],
    snapshot: (workerId) => {
      if (failHttpSnapshot && requestPath === '/api/sessions/worker-1')
        throw new Error('临时读取失败')
      return workerId === current.workerId ? current : null
    },
    open: async (cwd, sessionPath, model) => {
      calls.push({ type: 'open', cwd, sessionPath, model })
      return current
    },
    send: async (_workerId, text, _sessionId, _generation, images) => {
      calls.push({ type: 'send', text, images: images?.map((image) => image.mimeType) })
    },
    setModel: async (_workerId, _identity, providerId, modelId) => {
      calls.push({ type: 'model', providerId, modelId })
      current = { ...current, revision: current.revision + 1, provider: providerId, model: modelId }
      publish({ workerId: current.workerId, snapshot: current, runFinished: false })
    },
    setPermission: async (_workerId, mode) => {
      calls.push({ type: 'permission', mode })
      current = { ...current, revision: current.revision + 1, permissionMode: mode }
      publish({ workerId: current.workerId, snapshot: current, runFinished: false })
    },
    setThinking: async (_workerId, _identity, level) => {
      calls.push({ type: 'thinking', level })
      current = {
        ...current,
        revision: current.revision + 1,
        thinking: current.thinking ? { ...current.thinking, level } : null
      }
      publish({ workerId: current.workerId, snapshot: current, runFinished: false })
    },
    skills: async () => [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'code-review',
        description: 'Review the current change for bugs',
        scope: 'user',
        origin: 'top-level',
        mode: 'model-and-manual',
        canInsert: true
      }
    ],
    checkpointPlan: async (_workerId, _identity, entryId) => {
      calls.push({ type: 'plan', entryId })
      return {
        entryId,
        laterTurns: 0,
        files: [{ path: '/fixture/src/app.ts', action: 'restore', status: 'ready' }]
      }
    },
    checkpointRestore: async (_workerId, _identity, entryId, force) => {
      calls.push({ type: 'restore', entryId, force })
      current = {
        ...current,
        revision: current.revision + 1,
        checkpoints: [{ entryId, state: 'restored' }]
      }
      publish({ workerId: current.workerId, snapshot: current, runFinished: false })
      return { status: 'restored', restored: 1, skipped: [], failed: [] }
    },
    abort: async () => undefined,
    clearQueue: async () => undefined,
    respond: async (_workerId, approvalId, allow) => {
      responses.push({ approvalId, allow })
    },
    subscribe: (listener) => {
      publish = listener
      return () => {
        publish = () => undefined
      }
    }
  }
  let port = 0
  gateway = new MobileGatewayServer({
    pairing,
    sessions,
    port: 0,
    lanAddress: () => null,
    webRoot: resolve('out/renderer'),
    ...(views ? { views } : {}),
    snapshotStream: { maxFrameBytes },
    listen: (server, _port, host) =>
      new Promise((resolve, reject) => {
        server.prependListener('request', (request) => {
          requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
          paths.push(requestPath)
        })
        server.once('error', reject)
        server.listen(0, host, () => {
          port = (server.address() as AddressInfo).port
          resolve()
        })
      })
  })
  await gateway.start()
  const url = `http://127.0.0.1:${port}/?pair=${pairing.createOffer().token}#/s/worker-1`
  const script = join(root, 'main.cjs')
  await writeFile(
    script,
    `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(profile)});
    app.whenReady().then(() => {
      const window = new BrowserWindow({ width: 440, height: 800,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      window.loadURL(${JSON.stringify(url)});
    });
    app.on('window-all-closed', () => app.quit());
  `
  )
  app = await electron.launch({ args: [script] })
  const page = await app.firstWindow()
  return {
    page,
    paths,
    responses,
    calls,
    pairing,
    get current() {
      return current
    },
    setSnapshot(value: MobileConversationSnapshot) {
      current = value
    },
    allowHttpSnapshot() {
      failHttpSnapshot = false
    },
    publish() {
      publish({ workerId: current.workerId, snapshot: current, runFinished: false })
    }
  }
}

test('mobile delivery preserves full state when a large snapshot pauses live updates', async () => {
  const fixture = await launchMobile()
  const { page, paths } = fixture
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  await expect.poll(() => paths.filter((path) => path.endsWith('/events')).length).toBe(1)

  fixture.setSnapshot({
    ...fixture.current,
    revision: 2,
    status: 'awaiting-approval',
    busy: true,
    approvals: [
      {
        id: 'approval-1',
        generation: 1,
        toolCallId: 'tool-1',
        toolName: 'computer',
        intent: 'desktop',
        title: 'Pending desktop action',
        detail: 'Fixture only; no native input'
      }
    ],
    nodes: [{ id: 'reply', type: 'assistant', markdown: `latest-state ${'x'.repeat(2048)}` }]
  })
  fixture.publish()
  await expect(page.locator('#chat-scroll')).toContainText('latest-state')
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible()
  await expect(page.getByText(/实时更新已暂停/)).toBeVisible()
  await expect.poll(() => paths.filter((path) => path === '/api/sessions/worker-1').length).toBe(2)

  fixture.setSnapshot({
    ...fixture.current,
    revision: 3,
    busy: false,
    status: 'idle',
    approvals: [],
    nodes: [{ id: 'reply', type: 'assistant', markdown: 'manual-refresh-state' }]
  })
  await page.locator('#refresh-snapshot').click()
  await expect(page.locator('#chat-scroll')).toContainText('manual-refresh-state')
  await expect(page.getByRole('button', { name: '允许', exact: true })).toHaveCount(0)
  await expect.poll(() => paths.filter((path) => path === '/api/sessions/worker-1').length).toBe(3)
  // Observe an idle interval to catch a reconnect loop after manual refresh.
  await page.waitForTimeout(4000)
  expect(paths.filter((path) => path.endsWith('/events'))).toHaveLength(1)
})

test('an initial oversized snapshot still offers retry after the full HTTP refresh fails', async () => {
  const fixture = await launchMobile(`recovered-state ${'x'.repeat(2048)}`, true)
  const { page, paths } = fixture
  await expect(page.getByText(/实时更新已暂停/)).toBeVisible()
  await expect(page.locator('.pane-chat').getByText('临时读取失败', { exact: true })).toBeVisible()
  await expect(page.locator('#refresh-snapshot')).toBeVisible()
  fixture.allowHttpSnapshot()
  await page.locator('#refresh-snapshot').click()
  await expect(page.locator('#chat-scroll')).toContainText('recovered-state')
  await expect(page.getByText('临时读取失败', { exact: true })).toHaveCount(0)
  expect(paths.filter((path) => path.endsWith('/events'))).toHaveLength(1)
})

test('a failed mobile navigation preserves live updates for the displayed session', async () => {
  const fixture = await launchMobile()
  const { page } = fixture
  await page.setViewportSize({ width: 1200, height: 800 })
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  await expect.poll(() => gateway?.getDiagnostics().connections).toBe(1)
  const failure = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions/unavailable-worker') && response.status() === 404
  )
  await page.locator('[data-worker="unavailable-worker"]').click()
  await failure
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  fixture.setSnapshot({
    ...fixture.current,
    revision: 2,
    nodes: [{ id: 'reply', type: 'assistant', markdown: 'still-receiving-updates' }]
  })
  fixture.publish()
  await expect(page.locator('#chat-scroll')).toContainText('still-receiving-updates')
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-wide-layout.png') })
})

const patch = (path: string, from: string, to: string): string =>
  `--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n import { run } from './run'\n-${from}\n+${to}\n export default run\n`

test('mobile conversation groups work, shows diffs and asks for approval with a preview', async () => {
  const fixture = await launchMobile('initial-state', false, 1024 * 1024)
  const { page } = fixture
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  const change = (from: string, to: string, source: 'applied' | 'proposed') => ({
    path: '/fixture/src/app.ts',
    kind: 'edit' as const,
    source,
    patch: patch('src/app.ts', from, to),
    additions: 1,
    deletions: 1,
    anchored: source === 'applied',
    omitted: false
  })
  fixture.setSnapshot({
    ...fixture.current,
    revision: 2,
    status: 'awaiting-approval',
    busy: true,
    approvals: [
      {
        id: 'approval-edit',
        generation: 1,
        toolCallId: 'call-edit-2',
        toolName: 'edit',
        intent: 'diff',
        title: 'Edit src/app.ts',
        detail: '{}'
      }
    ],
    nodes: [
      { id: 'u1', type: 'user', text: 'Rename the greeting and run the tests' },
      {
        id: 't1',
        type: 'tool',
        toolCallId: 'call-read',
        name: 'read',
        intent: 'read',
        title: 'read /fixture/src/app.ts',
        status: 'success',
        output: 'const greeting = "hi"'
      },
      {
        id: 't2',
        type: 'tool',
        toolCallId: 'call-edit',
        name: 'edit',
        intent: 'diff',
        title: 'edit /fixture/src/app.ts',
        status: 'success',
        change: change('const greeting = "hi"', 'const greeting = "hello"', 'applied')
      },
      {
        id: 't3',
        type: 'tool',
        toolCallId: 'call-test',
        name: 'bash',
        intent: 'terminal',
        title: 'npm test',
        status: 'success',
        detail: 'npm test',
        output: '12 passed',
        durationMs: 2300
      },
      {
        id: 'a1',
        type: 'assistant',
        markdown: 'Renamed the greeting. Tests pass:\n\n```ts\nconst greeting = "hello"\n```'
      },
      { id: 'u2', type: 'user', text: 'Also export it' },
      {
        id: 't4',
        type: 'tool',
        toolCallId: 'call-edit-2',
        name: 'edit',
        intent: 'diff',
        title: 'edit /fixture/src/app.ts',
        status: 'awaiting-approval',
        change: change('export default run', 'export { greeting, run }', 'proposed')
      }
    ]
  } as MobileConversationSnapshot)
  fixture.publish()

  const chat = page.locator('#chat-scroll')
  await expect(chat.getByText('工作过程 · 3 项')).toBeVisible()
  await expect(chat.getByText('读取 1')).toBeVisible()
  await expect(chat.getByText('已修改 1 个文件')).toBeVisible()
  await expect(chat.locator('.m-approval')).toContainText('等待批准')
  await expect(chat.locator('.m-approval .tool-change')).toBeVisible()
  await chat.getByText('工作过程 · 3 项').click()
  await chat.getByRole('button', { name: /npm test/ }).click()
  await expect(chat.getByText('12 passed')).toBeVisible()
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-conversation-approval.png') })
  await chat.locator('.m-approval').screenshot({
    path: resolve('artifacts/e2e/mobile-approval-diff.png')
  })

  await chat.getByRole('button', { name: '允许', exact: true }).click()
  await expect.poll(() => fixture.responses).toEqual([{ approvalId: 'approval-edit', allow: true }])

  // Streaming output keeps the reader at the end without replacing earlier rows.
  const firstBubble = await chat.locator('.m-bubble').first().elementHandle()
  fixture.setSnapshot({
    ...fixture.current,
    revision: 3,
    status: 'running',
    approvals: [],
    nodes: [
      ...fixture.current.nodes.slice(0, -1),
      {
        ...fixture.current.nodes.at(-1)!,
        status: 'success'
      } as MobileConversationSnapshot['nodes'][number],
      {
        id: 'a2',
        type: 'assistant',
        markdown: 'Exported. ' + 'More detail. '.repeat(200),
        streaming: true
      }
    ]
  })
  fixture.publish()
  await expect(chat).toContainText('Exported.')
  expect(await firstBubble!.evaluate((node) => node.isConnected)).toBe(true)
  await expect
    .poll(() => chat.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(80)
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-conversation-streaming.png') })
})

test('mobile controls: permission, model, skills, images, undo and a new session', async () => {
  const fixture = await launchMobile('initial-state', false, 1024 * 1024)
  const { page, calls } = fixture
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  fixture.setSnapshot({
    ...fixture.current,
    revision: 2,
    provider: 'fixture',
    model: 'text-only',
    permissionMode: 'ask',
    models: [
      {
        provider: 'fixture',
        id: 'text-only',
        name: 'Text Only',
        image: false,
        reasoning: true,
        contextWindow: 200000
      },
      {
        provider: 'fixture',
        id: 'vision',
        name: 'Vision Pro',
        image: true,
        reasoning: true,
        contextWindow: 1000000
      },
      { provider: 'other', id: 'gone', name: 'Gone', image: false, unavailableReason: '未登录' }
    ],
    providers: { fixture: 'Fixture Cloud', other: 'Other Lab' },
    thinking: { level: 'medium', available: ['off', 'low', 'medium', 'high'] },
    checkpoints: [{ entryId: 'entry-1', state: 'available' }],
    nodes: [
      { id: 'u1', type: 'user', text: 'Rename it', canonicalEntryId: 'entry-1' },
      {
        id: 't1',
        type: 'tool',
        toolCallId: 'call-edit',
        name: 'edit',
        intent: 'diff',
        title: 'edit /fixture/src/app.ts',
        status: 'success',
        change: {
          path: '/fixture/src/app.ts',
          kind: 'edit',
          source: 'applied',
          anchored: true,
          patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
          additions: 1,
          deletions: 1
        }
      },
      { id: 'a1', type: 'assistant', markdown: 'Renamed.', canonicalEntryId: 'entry-2' }
    ]
  })
  fixture.publish()
  const chat = page.locator('#chat-scroll')
  await expect(chat.getByText('已修改 1 个文件')).toBeVisible()

  // Permission
  await page.getByRole('button', { name: '工具权限：请求批准' }).click()
  await page
    .getByRole('dialog', { name: '工具权限' })
    .getByRole('button', { name: /帮我批准/ })
    .click()
  await expect(page.getByRole('button', { name: '工具权限：帮我批准' })).toBeVisible()

  // Model: unavailable models are listed but cannot be picked.
  await page.getByRole('button', { name: '模型：Text Only' }).click()
  const models = page.getByRole('dialog', { name: '选择模型' })
  await expect(models.getByText('Fixture Cloud')).toBeVisible()
  await models.getByRole('radio', { name: '高', exact: true }).click()
  await expect(models.getByRole('radio', { name: '高', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(models.getByRole('button', { name: /Gone/ })).toBeDisabled()
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-model-sheet.png') })
  await models.getByRole('button', { name: /Vision Pro/ }).click()
  await expect(page.getByRole('button', { name: '模型：Vision Pro' })).toBeVisible()
  await expect(page.getByRole('button', { name: '模型：Vision Pro' })).toContainText('高')

  // Skills insert a slash command into the draft.
  await page.getByRole('button', { name: '使用技能' }).click()
  await page
    .getByRole('dialog', { name: '使用技能' })
    .getByRole('button', { name: /code-review/ })
    .click()
  const input = page.getByRole('textbox', { name: '提出后续要求' })
  await expect(input).toHaveValue('/skill:code-review ')
  await input.fill('/skill:code-review check the screenshot')

  // Images: a picked photo becomes a thumbnail and travels with the prompt.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png })
  await expect(page.locator('.m-thumb img')).toHaveCount(1)
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-composer-image.png') })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.m-thumb')).toHaveCount(0)

  // Undo the turn's file changes after confirming the plan.
  await chat.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(chat.getByRole('alertdialog', { name: '确认撤销' })).toContainText('src/app.ts')
  await chat.getByRole('button', { name: '撤销改动' }).click()
  await expect(chat.getByText('已撤销 1 个文件')).toBeVisible()

  // A new session in the same project keeps the chosen model.
  await page.getByRole('button', { name: '新会话' }).click()
  await expect
    .poll(() => calls.filter((call) => call.type !== 'plan'))
    .toEqual([
      { type: 'permission', mode: 'auto' },
      { type: 'thinking', level: 'high' },
      { type: 'model', providerId: 'fixture', modelId: 'vision' },
      { type: 'send', text: '/skill:code-review check the screenshot', images: ['image/png'] },
      { type: 'restore', entryId: 'entry-1', force: false },
      {
        type: 'open',
        cwd: '/fixture',
        sessionPath: undefined,
        model: { providerId: 'fixture', modelId: 'vision' }
      }
    ])
})

test('a session link survives its worker going away, on reload and while open', async () => {
  const fixture = await launchMobile()
  const { page, calls } = fixture
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  // The link learns the session file as soon as the snapshot names it.
  fixture.setSnapshot({ ...fixture.current, revision: 2, sessionPath: '/fixture/session.jsonl' })
  fixture.publish()
  await expect.poll(() => page.url()).toContain('path=%2Ffixture%2Fsession.jsonl')

  // Desktop restarted: the old worker is gone and reopening yields a new one.
  fixture.setSnapshot({
    ...fixture.current,
    workerId: 'worker-2',
    revision: 1,
    nodes: [{ id: 'reply', type: 'assistant', markdown: 'reopened-after-restart' }]
  })
  await page.reload()
  await expect(page.locator('#chat-scroll')).toContainText('reopened-after-restart')
  expect(page.url()).toContain('#/s/worker-2?')
  expect(calls).toContainEqual({
    type: 'open',
    cwd: '/fixture',
    sessionPath: '/fixture/session.jsonl',
    model: undefined
  })

  // Same while the page stays open: the stream drops, reconnects, and reopens the session.
  fixture.setSnapshot({
    ...fixture.current,
    workerId: 'worker-3',
    revision: 1,
    nodes: [{ id: 'reply', type: 'assistant', markdown: 'reconnected-live' }]
  })
  for (const client of (gateway as unknown as { sse: Set<{ response: { destroy(): void } }> }).sse)
    client.response.destroy()
  await expect(page.locator('#chat-scroll')).toContainText('reconnected-live', { timeout: 15000 })
  expect(page.url()).toContain('#/s/worker-3?')
})

test('pairs with a typed code and serves an installable app shell', async () => {
  const fixture = await launchMobile()
  const { page, pairing } = fixture
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  const origin = new URL(page.url()).origin

  const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json()
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', scope: '/' })
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512'])
  )
  const icon = await fetch(`${origin}/icon.png`)
  expect(icon.headers.get('content-type')).toBe('image/png')
  const worker = await fetch(`${origin}/sw.js`)
  expect(worker.headers.get('content-type')).toContain('javascript')
  await expect
    .poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())))
    .toBe(true)

  // A home-screen app starts without the browser's storage: pair it by typing the code.
  await page.evaluate(() => {
    localStorage.clear()
    document.cookie = 'pi_device=; Path=/; Max-Age=0'
  })
  await page.goto(`${origin}/`)
  await expect(page.getByRole('textbox', { name: '配对码' })).toBeVisible()
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-pairing.png') })
  const code = pairing.createOffer().token
  await page
    .getByRole('textbox', { name: '配对码' })
    .fill(`${code.slice(0, 4)} ${code.slice(4).toLowerCase()}`)
  await page.getByRole('button', { name: '配对', exact: true }).click()
  await expect(page.getByText('当前设备上的项目和会话')).toBeVisible()
})

/** A 1×1 grey JPEG; the page stretches it to the frame's aspect ratio. */
const PIXEL =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

test('remote workbench: the desktop browser as frames with taps, and a terminal with keys', async () => {
  const inputs: [string, unknown][] = []
  let access: 'off' | 'view' | 'control' = 'control'
  const views: MobileViewsBridge = {
    access: () => access,
    list: () => [
      { id: 'browser', kind: 'browser', title: '浏览器', detail: 'Dev server', live: true },
      { id: 'terminal:t1', kind: 'terminal', title: '终端 1', detail: 'fixture', live: true }
    ],
    subscribe: (id, send) => {
      if (id === 'browser') {
        send('state', {
          available: true,
          tabs: [
            {
              id: 'p1',
              title: 'Dev server',
              url: 'http://localhost:5173/',
              active: true,
              loading: false
            }
          ],
          canGoBack: true,
          canGoForward: false,
          mobile: false,
          controller: 'idle'
        })
        send('frame', { data: PIXEL, width: 400, height: 800 })
        return () => undefined
      }
      if (id === 'terminal:t1') {
        send('replay', {
          type: 'replay',
          data: 'hello from the desktop terminal\r\n$ ',
          cols: 60,
          rows: 20,
          state: 'running'
        })
        return () => undefined
      }
      return null
    },
    input: async (id, input) => {
      inputs.push([id, input])
    }
  }
  const fixture = await launchMobile('initial-state', false, 1024, views)
  const { page } = fixture
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  await page.getByRole('button', { name: '打开标签页' }).click()
  await expect(page.getByRole('heading', { name: '打开标签页' })).toBeVisible()
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-tabs.png') })
  await page.getByRole('button', { name: /浏览器/ }).click()
  const frame = page.locator('.m-rb-frame')
  await expect(frame).toBeVisible()
  await expect(page.getByRole('textbox', { name: '网址' })).toHaveValue('http://localhost:5173/')
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-remote-browser.png') })

  // A tap in the middle of the frame lands in the middle of the page (CSS pixels).
  const box = (await frame.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect.poll(() => inputs.at(-1)).toMatchObject(['browser', { type: 'tap' }])
  const tap = inputs.at(-1)![1] as { x: number; y: number }
  expect(Math.abs(tap.x - 200)).toBeLessThan(3)
  expect(Math.abs(tap.y - 400)).toBeLessThan(3)

  const address = page.getByRole('textbox', { name: '网址' })
  await address.fill('localhost:3000')
  await address.press('Enter')
  await page.getByRole('button', { name: '电脑尺寸' }).click()
  await expect
    .poll(() => inputs.slice(-2).map(([, input]) => input))
    .toEqual([
      { type: 'navigate', url: 'localhost:3000' },
      { type: 'device', mobile: true }
    ])

  // Terminal: the replay renders, keys and a typed command travel as input.
  await page.getByRole('button', { name: '返回' }).click()
  await page.getByRole('button', { name: /终端 1/ }).click()
  await expect(page.locator('.m-rt-screen')).toContainText('hello from the desktop terminal')
  await page.getByRole('button', { name: '^C' }).click()
  await page.getByRole('textbox', { name: '输入命令' }).fill('npm test')
  await page.getByRole('button', { name: '执行' }).click()
  await expect
    .poll(() => inputs.slice(-2))
    .toEqual([
      ['terminal:t1', { type: 'key', key: 'Ctrl-C' }],
      ['terminal:t1', { type: 'text', data: 'npm test\r' }]
    ])
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-remote-terminal.png') })

  // View-only access hides the controls.
  access = 'view'
  await page.reload()
  await expect(page.getByText('只读').first()).toBeVisible()
  await expect(page.getByRole('textbox', { name: '输入命令' })).toHaveCount(0)
})

test('plugin pages open on the phone in a sandboxed frame and confirm writes there', async () => {
  let access: 'off' | 'view' | 'control' = 'control'
  const calls: [string, unknown][] = []
  const gitRoot = await realpath(resolve('resources/plugins/git'))
  const context = {
    pluginId: 'works.pi.git',
    viewId: 'works.pi.git.changes',
    projectPath: '/fixture/shop',
    sessionId: null,
    generation: 1
  }
  const plugins = new MobilePluginViews({
    views: () => [
      {
        id: 'works.pi.git.changes',
        pluginId: 'works.pi.git',
        pluginName: 'Git',
        title: 'Git',
        available: true,
        root: gitRoot,
        entryPath: join(gitRoot, 'views', 'changes.html')
      }
    ],
    context: () => context,
    call: async (_viewId, method, params, approve) => {
      if (method === 'git.status')
        return {
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          files: [
            { path: 'src/app.ts', index: 'M', worktree: ' ' },
            { path: 'README.md', index: ' ', worktree: 'M' }
          ]
        }
      if (method === 'git.log')
        return { commits: [{ hash: 'abc1234', subject: 'Init', author: 'me', date: '' }] }
      if (method === 'git.diff') return { patch: '' }
      if (method === 'git.stage') {
        const paths = (params as { paths: string[] }).paths
        if (!(await approve({ title: `暂存 ${paths.length} 个文件`, detail: paths.join('\n') })))
          throw new PluginApiError('PERMISSION_DENIED', '用户拒绝了这次操作')
        calls.push([method, params])
        return undefined
      }
      throw new PluginApiError('UNSUPPORTED', method)
    }
  })
  const views: MobileViewsBridge = {
    access: () => access,
    list: () => [],
    subscribe: () => null,
    input: async () => undefined,
    plugins
  }
  const { page } = await launchMobile('initial-state', false, 1024, views)
  await expect(page.locator('#chat-scroll')).toContainText('initial-state')
  await page.getByRole('button', { name: '打开标签页' }).click()
  await page.getByRole('button', { name: /Git/ }).click()
  const git = page.frameLocator('iframe.m-plugin-frame')
  await expect(git.getByText('app.ts')).toBeVisible()
  await expect(git.locator('#branch-name')).toHaveText('main')
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-plugin-git.png') })

  // The page has an opaque origin: no device cookie, no gateway API.
  const frame = page.frames().find((item) => item.url().includes('/plugin-frame/'))!
  expect(
    await frame.evaluate(async () => {
      let cookie = 'readable'
      try {
        void document.cookie
      } catch {
        cookie = 'denied'
      }
      const api = await fetch('/api/me').then(
        () => 'reachable',
        () => 'blocked'
      )
      return { cookie, api }
    })
  ).toEqual({ cookie: 'denied', api: 'blocked' })

  // A write asks on the phone; declining runs nothing, allowing runs it once.
  await git.getByRole('button', { name: '暂存 README.md' }).click()
  const sheet = page.getByRole('dialog', { name: '确认操作' })
  await expect(sheet).toContainText('暂存 1 个文件')
  await sheet.getByRole('button', { name: '取消' }).click()
  expect(calls).toEqual([])
  await git.getByRole('button', { name: '暂存 README.md' }).click()
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-plugin-confirm.png') })
  await page.getByRole('dialog', { name: '确认操作' }).getByRole('button', { name: '允许' }).click()
  await expect.poll(() => calls).toEqual([['git.stage', { paths: ['README.md'] }]])

  // View-only access keeps reads and refuses writes before the desktop is asked.
  access = 'view'
  await git.getByRole('button', { name: '暂存 README.md' }).click()
  await expect(git.locator('#notice')).toContainText('只允许查看')
  expect(calls).toHaveLength(1)
})
