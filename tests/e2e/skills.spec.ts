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
import { build } from 'esbuild'
import { displayEnv } from './display-env'

let app: ElectronApplication, page: Page, root: string, project: string
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-skills-e2e-')))
  project = join(root, 'project')
  for (const name of [
    'home',
    'agent/extensions',
    'agent/skills/review-code',
    'project/.pi/skills/manual-review',
    'user-data'
  ])
    await mkdir(join(root, name), { recursive: true })
  await writeFile(
    join(root, 'agent/skills/review-code/SKILL.md'),
    '---\nname: review-code\ndescription: 检查代码质量和潜在缺陷\n---\n# Review code\nSKILLS_BODY_SENTINEL\nUse precise evidence.'
  )
  await writeFile(
    join(project, '.pi/skills/manual-review/SKILL.md'),
    '---\nname: manual-review\ndescription: 仅在明确选择时开展审阅\ndisable-model-invocation: true\n---\n# Manual review\nMANUAL_BODY_SENTINEL'
  )
  await writeFile(
    join(root, 'agent/auth.json'),
    JSON.stringify({ 'skills-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(root, 'agent/settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  await writeFile(join(root, 'context.txt'), 'Attachment fixture')
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(root, 'agent/extensions/fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, getCurrentSystemPrompt } from ${JSON.stringify(resolve(aiRoot, pkg.exports['.'].import))};
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      const faux = fauxProvider({ provider: 'skills-fixture', api: 'skills-fixture-api', models: [{ id: 'offline' }], tokensPerSecond: 1000 });
      pi.registerProvider(faux.provider);
      faux.setResponses([(context) => {
        writeFileSync(${JSON.stringify(join(root, 'received.json'))}, JSON.stringify({
          ...context,
          systemPrompt: getCurrentSystemPrompt(context.messages)
        }));
        return fauxAssistantMessage('技能命令已由原生 Pi 展开。');
      }]);
    }
  `
  )
  app = await electron.launch({
    args: [resolve('.')],
    cwd: root,
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      PI_CODING_AGENT_DIR: join(root, 'agent')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'skills-fixture', modelId: 'offline' })
  )
  await expect(page.getByRole('textbox', { name: '任务输入', exact: true })).toBeEnabled()
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})
async function settings() {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Skills 技能', exact: true }).click()
  await expect(page.locator('.skills-count')).toContainText('已加载 2 个')
}

test('loaded catalog, scopes, manual-only detail, screenshots, insertion and real SDK expansion', async ({}, testInfo) => {
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await draft.fill('保留这段任务')
  await settings()
  await expect(page.locator('.skills-settings')).toContainText('刷新不会重新扫描')
  await page.getByLabel('技能范围').selectOption('project')
  await expect(page.locator('.skill-row')).toHaveCount(1)
  await expect(page.locator('.skill-row')).toContainText('仅手动调用')
  await page.getByLabel('技能范围').selectOption('all')
  await page.getByLabel('搜索技能').fill('没有这项技能')
  await expect(page.locator('.skills-empty')).toContainText('没有匹配')
  await page.getByLabel('搜索技能').fill('')
  for (const width of [960, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({ path: testInfo.outputPath(`skills-list-${width}.png`) })
  }
  await page.getByRole('button', { name: /manual-review.*仅在明确选择/ }).click()
  await expect(page.getByLabel('技能内容')).toContainText('MANUAL_BODY_SENTINEL')
  for (const width of [960, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`skills-detail-${width}.png`) })
  }
  await page.getByRole('button', { name: '插入到输入框', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).not.toBeVisible()
  await expect(draft).toHaveValue('/skill:manual-review 保留这段任务')
  await expect(draft).toBeFocused()
  expect(
    (await page.evaluate(() => window.pi.getState())).nodes.filter((n) => n.type === 'user')
  ).toHaveLength(0)
  await expect(page.getByRole('button', { name: '添加文本文件', exact: true })).toBeDisabled()
  await expect(page.getByText('技能命令暂不能搭配文本附件；移除技能命令后可添加附件。', { exact: true })).toBeVisible()
  await draft.press('Enter')
  await expect(page.locator('.assistant-node')).toContainText('技能命令已由原生 Pi 展开。')
  const received = JSON.parse(await readFile(join(root, 'received.json'), 'utf8'))
  const user = received.messages.find((message: { role: string }) => message.role === 'user')
  expect(JSON.stringify(user)).toContain('MANUAL_BODY_SENTINEL')
  expect(JSON.stringify(user)).toContain('保留这段任务')
  // Pi providers receive a normalized transcript; system prompt sections live in system messages.
  expect(received.messages[0].role).toBe('system')
  const systemPrompt = received.systemPrompt
  expect(systemPrompt).toContain('检查代码质量和潜在缺陷')
  expect(systemPrompt).not.toContain('仅在明确选择时开展审阅')
  expect(systemPrompt).not.toContain('MANUAL_BODY_SENTINEL')
})

test('slash keyboard selection preserves suffix and attachment conflict prevents accidental non-expanded send', async ({}, testInfo) => {
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true })
  await expect(page.getByRole('button', { name: '选择技能', exact: true })).toHaveCount(0)
  await draft.fill('/review-code Existing draft')
  await expect(page.getByRole('option')).toHaveCount(1)
  await draft.press('Enter')
  await expect(draft).toHaveValue('/skill:review-code Existing draft')
  expect(
    (await page.evaluate(() => window.pi.getState())).nodes.filter((n) => n.type === 'user')
  ).toHaveLength(0)
  await draft.fill('/')
  await expect(page.getByRole('option')).toHaveCount(2)
  await draft.press('ArrowDown')
  await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await draft.press('ArrowUp')
  await expect(page.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.setViewportSize({ width: 960, height: 1000 })
  await page.screenshot({ path: testInfo.outputPath('skills-slash-composer-960.png') })
  await draft.press('Escape')
  await expect(page.getByRole('listbox', { name: '技能命令' })).toHaveCount(0)
  await expect(draft).toHaveValue('/')
  await draft.fill('/no-match')
  await expect(page.locator('.skill-slash-menu')).toContainText('没有匹配')
  await draft.press('Enter')
  await expect(draft).toHaveValue('/no-match')
  await draft.fill('/skill:manual')
  await expect(page.getByRole('option')).toHaveCount(1)
  await draft.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(draft).toHaveValue('/skill:manual')
  await draft.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
  await expect(draft).toHaveValue('/skill:manual')
  await draft.press('Shift+Enter')
  await expect(draft).toHaveValue('/skill:manual\n')
  await draft.press('Escape')
  await draft.fill('With attachment')
  await expect(page.getByText('技能命令暂不能搭配文本附件；移除技能命令后可添加附件。', { exact: true })).toHaveCount(0)
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    },
    join(root, 'context.txt')
  )
  await page.getByRole('button', { name: '添加文本文件', exact: true }).click()
  await expect(page.getByRole('list', { name: '已选择的文本文件' })).toContainText('context.txt')
  await draft.fill('/')
  await expect(page.locator('.skill-slash-menu')).toHaveCount(0)
  await draft.fill('/skill:review-code With attachment')
  await expect(page.getByRole('alert')).toContainText('请先移除附件')
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled()
  await draft.press('Enter')
  expect(
    (await page.evaluate(() => window.pi.getState())).nodes.filter((n) => n.type === 'user')
  ).toHaveLength(0)
  await page.getByRole('button', { name: '移除 context.txt', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled()
})

test('refresh keeps cached SDK list, changed previews and stale identities are rejected', async () => {
  const state = await page.evaluate(() => window.pi.getState())
  const catalog = await page.evaluate(async () => {
    const s = await window.pi.getState()
    return window.pi.send({
      type: 'skills:list',
      sessionId: s.sessionId!,
      generation: s.generation
    })
  })
  await writeFile(join(root, 'agent/skills/review-code/SKILL.md'), '# Changed after load')
  const id = catalog.catalog.skills.find((skill) => skill.name === 'review-code')!.id
  expect(
    await page.evaluate(
      async ({ id, sessionId, generation }) => {
        try {
          await window.pi.send({ type: 'skills:detail', id, sessionId, generation })
          return false
        } catch {
          return true
        }
      },
      { id, sessionId: state.sessionId!, generation: state.generation }
    )
  ).toBe(true)
  await mkdir(join(project, '.pi/skills/new-skill'), { recursive: true })
  await writeFile(
    join(project, '.pi/skills/new-skill/SKILL.md'),
    '---\nname: new-skill\ndescription: newly added\n---\nNew'
  )
  await settings()
  await page.getByRole('button', { name: '刷新技能列表' }).click()
  await expect(page.locator('.skills-count')).toContainText('已加载 2 个')
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.evaluate(() => window.pi.send({ type: 'session:new' }))
  expect(
    await page.evaluate(
      async ({ sessionId, generation }) => {
        try {
          await window.pi.send({ type: 'skills:list', sessionId, generation })
          return false
        } catch {
          return true
        }
      },
      { sessionId: state.sessionId!, generation: state.generation }
    )
  ).toBe(true)
})

test('real Composer discards delayed lists and stale insertions across sessions in StrictMode', async () => {
  const windowReady = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }) => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    void window.loadURL('about:blank')
  })
  const harness = await windowReady
  const bundle = await build({
    stdin: {
      contents: `
    import React, {StrictMode} from 'react';
    import {createRoot} from 'react-dom/client';
    import Conversation from ${JSON.stringify(resolve('src/renderer/src/components/Conversation.tsx'))};
    import {useDesktopSettings} from ${JSON.stringify(resolve('src/renderer/src/store/desktop-settings.ts'))};
    useDesktopSettings.setState({hasLoaded:true,status:'ready'});
    import {EMPTY_SNAPSHOT,usePiStore} from ${JSON.stringify(resolve('src/renderer/src/store/pi-store.ts'))};
    import {useSkillInsertion} from ${JSON.stringify(resolve('src/renderer/src/store/skill-draft.ts'))};
    const skill={id:'c9557759-94b9-4943-a25f-084bf742f419',name:'example',description:'Fixture',scope:'project',origin:'top-level',mode:'manual-only',canInsert:true};
    let pending=[]; window.sent=0;
    window.pi={send: command => new Promise(resolve => pending.push(() => resolve({kind:'skills-list',catalog:{sessionId:command.sessionId,generation:command.generation,skills:[skill],total:1,truncated:false}})))};
    const initial={...EMPTY_SNAPSHOT,ready:true,sessionId:'a',generation:1,project:{path:'/fixture',name:'Fixture'},modelAvailability:'available',composeBlockReason:null,activeProvider:'fixture',activeModel:'offline',models:[{provider:'fixture',id:'offline',name:'offline',contextWindow:1000,reasoning:false}],accounts:[{id:'fixture',name:'Fixture',connected:true,authType:'api_key',subscription:false,alias:false}]};
    usePiStore.setState({snapshot:initial});
    window.skillHarness={release:()=>{const held=pending;pending=[];held.forEach(resolve=>resolve())},switchSession:(sessionId)=>usePiStore.setState({snapshot:{...initial,sessionId,generation:sessionId==='a'?1:2}}),insert:(sessionId)=>useSkillInsertion.getState().request({identity:{project:'/fixture',sessionId,generation:sessionId==='a'?1:2},skill})};
    const noop=()=>{};
    function Harness(){const snapshot=usePiStore(state=>state.snapshot);return <Conversation snapshot={snapshot} approvals={[]} loading={false} onSend={async()=>{window.sent++;return true}} onChooseProject={noop} onOpenSession={noop} onReconnect={noop} reconnecting={false} onAbort={noop} onClearQueue={noop} onPermissionChange={noop} onChooseModel={noop} onLogin={noop} onOpenSettings={noop} onApproval={noop}/>}
    createRoot(document.getElementById('root')).render(<StrictMode><Harness/></StrictMode>);
  `,
      loader: 'tsx',
      resolveDir: resolve('.')
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty' }
  })
  await harness.setContent('<div id="root"></div>')
  await harness.addScriptTag({ content: bundle.outputFiles[0].text })
  const input = harness.getByRole('textbox', { name: '任务输入', exact: true })
  await input.fill('/exa Task A')
  await expect(harness.getByRole('status')).toContainText('正在读取')
  await input.press('Enter')
  await expect(input).toHaveValue('/exa Task A')
  await harness.evaluate(() => (window as any).skillHarness.switchSession('b'))
  await input.fill('Task B updated while waiting')
  await harness.evaluate(() => {
    ;(window as any).skillHarness.release()
    ;(window as any).skillHarness.insert('a')
  })
  await expect(input).toHaveValue('Task B updated while waiting')
  await expect(harness.getByRole('listbox')).toHaveCount(0)
  await harness.evaluate(() => (window as any).skillHarness.insert('b'))
  await expect(input).toHaveValue('/skill:example Task B updated while waiting')
  await harness.evaluate(() => (window as any).skillHarness.switchSession('a'))
  await expect(input).toHaveValue('/exa Task A')
  await input.fill('/no-match Latest suffix')
  await harness.evaluate(() => (window as any).skillHarness.release())
  await expect(harness.locator('.skill-slash-menu')).toContainText('没有匹配')
  await input.press('Enter')
  await expect(input).toHaveValue('/no-match Latest suffix')
  expect(await harness.evaluate(() => (window as any).sent)).toBe(0)
})
