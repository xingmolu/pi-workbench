import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { MobileGatewayServer } from '../../src/main/mobile-gateway'
import { MobilePairingStore } from '../../src/main/mobile-pairing'
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
  maxFrameBytes = 1024
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
      { provider: 'fixture', id: 'text-only', name: 'Text Only', image: false },
      { provider: 'fixture', id: 'vision', name: 'Vision Pro', image: true },
      { provider: 'other', id: 'gone', name: 'Gone', image: false, unavailableReason: '未登录' }
    ],
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
  await expect(models.getByRole('button', { name: /Gone/ })).toBeDisabled()
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve('artifacts/e2e/mobile-model-sheet.png') })
  await models.getByRole('button', { name: /Vision Pro/ }).click()
  await expect(page.getByRole('button', { name: '模型：Vision Pro' })).toBeVisible()

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
