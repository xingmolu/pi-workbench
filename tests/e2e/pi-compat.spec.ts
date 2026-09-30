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

const artifacts = resolve('artifacts/e2e/pi-compat')
let app: ElectronApplication, page: Page, root: string, project: string

/**
 * A plugin written against documented plugin interface (manifest.json, its
 * permission names, `execute`, `window.pluginBridge`, `onPanelInvoke`). Written for this test.
 */
async function writeCompatPlugin(plugin: string): Promise<void> {
  await mkdir(join(plugin, 'panel'), { recursive: true })
  await mkdir(join(plugin, 'skills'), { recursive: true })
  await writeFile(
    join(plugin, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'compat.notes',
      name: 'Compat Notes',
      version: '0.2.0',
      author: 'Test',
      main: 'main.js',
      ui: {
        panel: 'panel/index.html',
        width: 420,
        height: 320,
        title: { en: 'Notes', 'zh-CN': '笔记面板' }
      },
      contributes: {
        commands: [
          { id: 'notes.open', title: 'Notes: Open Panel', keywords: ['notes'], category: 'Demo' }
        ],
        agentTools: [
          {
            name: 'echo_text',
            description: 'Echo text back to the agent',
            risk: 'low',
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
          }
        ],
        skills: ['./skills/notes.md'],
        settings: [{ key: 'greeting', type: 'string', default: 'Hello', title: 'Greeting' }],
        services: [{ id: 'heartbeat', label: 'Heartbeat' }],
        bus: { publish: ['compat.notes.opened'], subscribe: ['compat.**'] }
      },
      permissions: [
        'ui.panel',
        'agent.tool.register',
        'agent.prompt.inject',
        'background.service',
        'bus.publish',
        'bus.subscribe'
      ],
      engines: { piDesktop: '>=0.1.0' },
      activationEvents: ['onCommand:notes.open', 'onStartup']
    })
  )
  await writeFile(
    join(plugin, 'main.js'),
    `async function onLoad() {
      await pi.commands.register({
        id: 'notes.open',
        title: 'Notes: Open Panel',
        run: async () => {
          const settings = await pi.plugin.getSettings()
          await pi.ui.openPanel({ title: 'Notes' })
          await pi.ui.showToast(settings.greeting + ' from ' + pi.plugin.getId())
          await pi.bus.publish('compat.notes.opened', {})
        }
      })
      await pi.agent.registerTool({
        name: 'echo_text',
        description: 'Echo text back to the agent',
        risk: 'low',
        schema: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (args, context) => {
          context.log('echo_text called')
          return { ok: true, echo: String(args.text), pluginId: pi.plugin.getId() }
        }
      })
      await pi.bus.subscribe('compat.**', async () => {})
      pi.services.register({ id: 'heartbeat', start: () => {}, stop: () => {} })
    }
    async function onPanelInvoke(channel, payload) {
      if (channel === 'notes.count') return { count: 3, asked: payload.kind }
      throw new Error('unknown channel ' + channel)
    }
    module.exports = { onLoad, onPanelInvoke, onUnload: async () => {} }`
  )
  await writeFile(
    join(plugin, 'panel', 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8"><title>Notes</title></head><body><p id="out">…</p><script>window.__inline = "ran"</script><script src="./panel.js"></script></body></html>'
  )
  await writeFile(
    join(plugin, 'panel', 'panel.js'),
    `window.__result = null
    ;(async () => {
      const workspace = await window.pluginBridge.invoke('workspace.get')
      const count = await window.pluginBridge.invoke('notes.count', { kind: 'all' })
      const appearance = await window.pluginBridge.invoke('app.getAppearance')
      await window.pluginBridge.invoke('ui.showToast', { message: 'from the panel' })
      window.__result = { workspace: workspace.path, count, base: typeof appearance.base, inline: window.__inline }
      document.getElementById('out').textContent = JSON.stringify(window.__result)
    })().catch((error) => { window.__result = { error: error.code || String(error) } })`
  )
  await writeFile(
    join(plugin, 'skills', 'notes.md'),
    '---\nname: compat-notes\ndescription: How to use the notes plugin.\n---\n\nUse echo_text to confirm.\n'
  )
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-compat-')))
  project = join(root, 'shop')
  const agent = join(root, 'agent')
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
  await writeCompatPlugin(join(agent, 'desktop-plugins', 'notes'))
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, pkg.exports['.'].import)
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ 'coding-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider:'coding-fixture', api:'coding-fixture-api', models:[{id:'offline'}], tokensPerSecond:400, tokenSize:{min:4,max:4} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('echo-fixture', { description:'Calls the compat tool', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('compat_notes__echo_text', {text:'ping'}, {id:'echo-' + Date.now()})], {stopReason:'toolUse'}),
          fauxAssistantMessage(fauxText('插件回显完成。'))
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
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
})

test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('a manifest.json plugin loads, is granted, runs commands, panels and settings', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
  const row = page.locator('.plugin-row').filter({ hasText: 'Compat Notes' })
  // Declared features this host does not have are named, not silently dropped.
  await expect(row.locator('.plugin-diagnostics')).toContainText('常驻服务')
  await expect(row.locator('.plugin-diagnostics')).toContainText('消息总线')
  await row.getByRole('switch', { name: 'Compat Notes Desktop 面板' }).click()
  const review = row.getByRole('group', { name: '授权 Compat Notes' })
  await expect(review).toContainText('agent.tools')
  await expect(review).toContainText('agent.skills')
  await review.getByRole('button', { name: '授权并启用' }).click()
  await expect(row).toContainText('运行中')

  const greeting = row.getByRole('textbox', { name: 'Compat Notes 设置：Greeting' })
  await expect(greeting).toHaveValue('Hello')
  await greeting.fill('Hi there')
  await greeting.blur()
  await page.screenshot({ path: join(artifacts, 'settings.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()

  await page.getByRole('button', { name: '搜索所有会话' }).click()
  await page.getByRole('combobox', { name: '搜索所有会话标题' }).fill('notes')
  await page.getByRole('option', { name: /Notes: Open Panel/ }).click()
  await expect(page.locator('.navigation-toast')).toContainText('Hi there from compat.notes')
  await expect(page.getByRole('tab', { name: /笔记面板/ })).toBeVisible()
  await expect
    .poll(() =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().endsWith('/panel/index.html'))
          ?.executeJavaScript('window.__result')
      )
    )
    .toEqual({
      workspace: project,
      count: { count: 3, asked: 'all' },
      base: 'string',
      // manifest.json pages rely on inline scripts; this plugin came from its manifest.
      inline: 'ran'
    })
  await expect(page.locator('.navigation-toast')).toContainText('from the panel')
  await page.screenshot({ path: join(artifacts, 'panel.png'), animations: 'disabled' })

  // Its agent tool, written with `execute` and `schema`, runs for a new session.
  await page.evaluate(() =>
    window.pi.send({ type: 'session:new', providerId: 'coding-fixture', modelId: 'offline' })
  )
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({
      type: 'prompt:send',
      text: '/echo-fixture',
      sessionId: sessionId!,
      generation
    })
  })
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('回显一下')
  await draft.press('Enter')
  await expect(page.locator('.assistant-node').last()).toContainText('插件回显完成')
  await page
    .getByRole('button', { name: /工作过程/ })
    .last()
    .click()
  await page.getByRole('button', { name: /compat_notes__echo_text/ }).click()
  await expect(page.locator('.tool-output').last()).toContainText('"echo":"ping"')
  await page.screenshot({ path: join(artifacts, 'tool.png'), animations: 'disabled' })
  const catalog = await page.evaluate(async () => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({ type: 'skills:list', sessionId: sessionId!, generation })
  })
  expect(JSON.stringify(catalog)).toContain('compat-notes')
})
