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

let app: ElectronApplication, page: Page, root: string, project: string
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-work-summary-')))
  project = join(root, 'project')
  const agent = join(root, 'agent')
  await Promise.all([
    mkdir(project),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(resolve('artifacts/e2e'), { recursive: true })
  ])
  const aiRoot = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8'))
  const publicAI = resolve(aiRoot, pkg.exports['.'].import)
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ 'work-fixture': { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } })
  )
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider:'work-fixture', api:'work-fixture-api', models:[{id:'offline',reasoning:true}], tokensPerSecond:100, tokenSize:{min:2,max:2} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('work-fixture', { description:'Offline work fixture', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxThinking('先检查项目目录，然后读取文件。'.repeat(8)), fauxToolCall('read', {path:${JSON.stringify(join(project, 'input.txt'))}}, {id:'read-one'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('read', {path:${JSON.stringify(join(project, 'input.txt'))}}, {id:'read-two'})], {stopReason:'toolUse'}),
          fauxAssistantMessage(fauxText('检查完成，两个读取结果一致。'))
        ]);
      }});
      pi.registerCommand('approval-fixture', { description:'Offline approval fixture', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxThinking('需要写入一个测试文件。'), fauxToolCall('write', {path:${JSON.stringify(join(project, 'output.txt'))},content:'approved'}, {id:'write-one'})], {stopReason:'toolUse'}),
          fauxAssistantMessage('操作已处理。')
        ]);
      }});
      pi.registerCommand('failure-fixture', { description:'Offline tool failure', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall('read',{path:${JSON.stringify(join(project, 'missing.txt'))}}, {id:'missing'}),{stopReason:'toolUse'}),
          fauxAssistantMessage('文件读取失败，请检查路径。')
        ]);
      }});
      pi.registerCommand('stop-fixture', { description:'Offline thinking stop', handler:async () => {
        faux.setResponses([fauxAssistantMessage(fauxThinking('持续检查中。'.repeat(200)))]);
      }});
    }
  `
  )
  await writeFile(join(project, 'input.txt'), 'offline fixture input')
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
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).models.some((m) => m.provider === 'work-fixture')
      )
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'work-fixture', modelId: 'offline' })
  )
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function run(command: string, prompt: string): Promise<void> {
  await page.evaluate(async (text) => {
    const { sessionId, generation } = await window.pi.getState()
    return window.pi.send({ type: 'prompt:send', text, sessionId: sessionId!, generation })
  }, command)
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.fill(prompt)
  await draft.press('Enter')
}

test('user disclosure survives live canonical reconciliation and keyboard collapse', async () => {
  await run('/work-fixture', '验证流式展开状态')
  const trigger = page.locator('.work-summary-trigger').first()
  await expect(trigger).toContainText('正在工作')
  await trigger.focus()
  await page.keyboard.press('Space')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.assistant-node').last()).toContainText('检查完成')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Space')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.assistant-node').last()).toBeVisible()
})

test('rejection, tool errors and stopped notices remain visible', async () => {
  await run('/approval-fixture', '拒绝这次写入')
  await page.locator('.approval-card').getByRole('button', { name: '拒绝', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(page.locator('.tool-node.is-blocked')).toBeVisible()
  await expect(page.locator('.tool-node.is-blocked .tool-detail')).toBeVisible()
  await run('/failure-fixture', '读取不存在的文件')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(page.locator('.tool-node.is-error')).toBeVisible()
  await expect(page.locator('.tool-node.is-error .tool-output')).toBeVisible()
  await run('/stop-fixture', '停止长时间思考')
  await expect(page.locator('.work-summary-trigger').last()).toContainText('正在工作')
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(page.locator('.stopped-node')).toBeVisible()
})

async function capture(name: string): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  )
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64')
  )
  await writeFile(resolve(`artifacts/e2e/${name}.png`), Buffer.from(png, 'base64'))
}

for (const width of [960, 1440]) {
  test(`offline SDK work collapses and expands with answers visible at ${width}`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
      width
    )
    await run('/work-fixture', '检查项目文件并给出结果')
    const trigger = page.locator('.work-summary-trigger').first()
    await expect(trigger).toContainText('正在工作')
    await expect(page.locator('.assistant-node').last()).toContainText(
      '检查完成，两个读取结果一致。'
    )
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).busy))
      .toBe(false)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toContainText('工作过程 · 3 项')
    await expect(page.locator('.think-trigger')).toBeHidden()
    await capture(`work-summary-${width}-collapsed`)
    const collapsed = await page
      .locator('.work-summary')
      .evaluate((el) => el.getBoundingClientRect().height)
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(trigger).toBeFocused()
    await page.locator('.think-trigger').click()
    await expect(page.locator('.think-content')).toContainText('先检查项目目录')
    for (const tool of await page.locator('.tool-trigger').all()) await tool.click()
    await expect(page.locator('.tool-output')).toHaveCount(2)
    expect(
      await page.locator('.work-summary').evaluate((el) => el.getBoundingClientRect().height)
    ).toBeGreaterThan(collapsed + 100)
    await capture(`work-summary-${width}-expanded`)
    await run('/approval-fixture', '写入测试文件')
    const approval = page.locator('.approval-card')
    await expect(approval).toBeVisible()
    await page.locator('.approval-jump').click()
    await expect(approval).toBeFocused()
    await expect(approval).toBeInViewport()
    await capture(`work-summary-${width}-approval`)
    await approval.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).busy))
      .toBe(false)
    expect(await readFile(join(project, 'output.txt'), 'utf8')).toBe('approved')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })
}
