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
      pi.registerCommand('separate-fixture', { description:'Same commands in separate model responses', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall('bash', {command:'printf FIRST'}, {id:'separate-one'}), {stopReason:'toolUse'}),
          fauxAssistantMessage(fauxToolCall('bash', {command:'printf SECOND'}, {id:'separate-two'}), {stopReason:'toolUse'}),
          fauxAssistantMessage('PAIR_COMPLETE')
        ]);
      }});
      pi.registerCommand('pair-fixture', { description:'Minimal same-response mutation pair', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall('bash', {command:'printf FIRST'}, {id:'pair-one'}),
            fauxToolCall('bash', {command:'printf SECOND'}, {id:'pair-two'})
          ], {stopReason:'toolUse'}),
          fauxAssistantMessage('PAIR_COMPLETE')
        ]);
      }});
      pi.registerCommand('mixed-fixture', { description:'Ordered write edit bash batch', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall('write', {path:'mixed.txt',content:'before'}, {id:'mixed-write'}),
            fauxToolCall('edit', {path:'mixed.txt',oldText:'before',newText:'after'}, {id:'mixed-edit'}),
            fauxToolCall('bash', {command:'cat mixed.txt'}, {id:'mixed-bash'})
          ], {stopReason:'toolUse'}),
          fauxAssistantMessage('MIXED_COMPLETE')
        ]);
      }});
      pi.registerCommand('slow-batch-fixture', { description:'Abort before a queued write', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall('bash', {command:'sleep 10'}, {id:'slow-first'}),
            fauxToolCall('write', {path:'must-not-exist.txt',content:'unexpected'}, {id:'never-write'})
          ], {stopReason:'toolUse'}),
          fauxAssistantMessage('SLOW_COMPLETE')
        ]);
      }});
      pi.registerCommand('batch-fixture', { description:'Three mutations in one model response', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall('bash', {command:'printf FIRST'}, {id:'batch-one'}),
            fauxToolCall('bash', {command:'printf EXPECTED_FAILURE; exit 7'}, {id:'batch-two'}),
            fauxToolCall('bash', {command:'printf RECOVERED'}, {id:'batch-three'})
          ], {stopReason:'toolUse'}),
          fauxAssistantMessage('BATCH_COMPLETE')
        ]);
      }});
    }
  `
  )
  await writeFile(join(project, 'input.txt'), 'offline fixture input')
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

test('light theme keeps the completed conversation and work details readable', async () => {
  await run('/work-fixture', '浅色主题阅读检查：请读取测试文件并报告结果。')
  await expect(page.locator('.assistant-node').last()).toContainText('检查完成')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page.locator('.work-summary-trigger').first().click()
  await expect(page.locator('.work-summary-content').first()).toBeVisible()
  await expect(page.locator('.assistant-node').last()).toContainText('检查完成')
  await page.getByRole('textbox', { name: '给 Pi 的任务', exact: true }).fill('继续检查文件内容')
  expect(await page.getByRole('textbox', { name: '给 Pi 的任务', exact: true }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none')
  await page.screenshot({ path: 'artifacts/e2e/theme-light-conversation.png' })
})

test('composer focus stays neutral and bottom shortcut floats without layout shift', async () => {
  await run('/work-fixture', '验证阅读导航\n'.repeat(70))
  await expect(page.locator('.assistant-node').last()).toContainText('检查完成')
  const draft = page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })
  await draft.focus()
  expect(await draft.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none')
  const before = await draft.boundingBox()
  await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  const jump = page.getByRole('button', { name: '回到底部', exact: true })
  await expect(jump).toBeVisible()
  const bounds = await jump.boundingBox()
  const after = await draft.boundingBox()
  expect(after!.y).toBe(before!.y)
  expect(bounds!.width).toBe(32)
  expect(Math.abs(bounds!.x + bounds!.width / 2 - (after!.x + after!.width / 2))).toBeLessThan(3)
  await page.screenshot({ path: 'artifacts/e2e/reading-composer-polish.png' })
  await jump.click()
  await expect(jump).toHaveCount(0)
  expect(await page.locator('.conversation-scroll').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3)
})

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

test('error details and their work group can be collapsed after acknowledgement', async () => {
  await run('/failure-fixture', '读取不存在文件后收起过程')
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  const tool = page.locator('.tool-node.is-error .tool-trigger')
  await expect(tool).toHaveAttribute('aria-expanded', 'true')
  await tool.click()
  await expect(tool).toHaveAttribute('aria-expanded', 'false')
  const group = page.locator('.work-summary-trigger').last()
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.assistant-node').last()).toBeVisible()
})

for (const mode of ['ask', 'open'] as const)
  test(`mixed write edit bash batch completes in ${mode}`, async () => {
    await page.evaluate((mode) => window.pi.send({ type: 'permission:set', mode }), mode)
    await run('/mixed-fixture', '顺序写入编辑读取')
    if (mode === 'ask')
      for (let i = 0; i < 3; i++) {
        await page.getByRole('button', { name: '允许一次', exact: true }).click()
      }
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).busy))
      .toBe(false)
    expect(await readFile(join(project, 'mixed.txt'), 'utf8')).toBe('after')
    await expect(page.locator('.assistant-node').last()).toContainText('MIXED_COMPLETE')
  })

test('denying one command does not strand the next command in a batch', async () => {
  await run('/pair-fixture', '拒绝第一条后继续第二条')
  await page.getByRole('button', { name: '拒绝', exact: true }).click()
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(page.locator('.assistant-node').last()).toContainText('PAIR_COMPLETE')
  const blocked = page.locator('.tool-node.is-blocked .tool-trigger')
  await blocked.click()
  await expect(blocked).toHaveAttribute('aria-expanded', 'false')
})

test('stop cancels the remaining batch without executing its queued write', async () => {
  await run('/slow-batch-fixture', '停止后不应写入')
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect(page.locator('.work-summary-trigger').last()).toContainText('正在工作', {
    timeout: 2000
  })
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).busy)).toBe(false)
  await expect(readFile(join(project, 'must-not-exist.txt'), 'utf8')).rejects.toThrow()
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.pi.getState()).nodes.filter(
            (n) =>
              n.type === 'tool' &&
              ['queued', 'running', 'waiting-resource', 'awaiting-approval'].includes(n.status)
          ).length
      )
    )
    .toBe(0)
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

for (const width of [960, 1440])
  test(`diagnostic: inner thinking repeatedly collapses during streaming and after stop at ${width}`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900),
      width
    )
    await run('/stop-fixture', '反复展开收起思考')
    await page.locator('.work-summary-trigger').last().click()
    const think = page.locator('.think-trigger').last()
    for (let i = 0; i < 8; i++) {
      await think.click()
      await expect(think).toHaveAttribute('aria-expanded', 'true')
      await think.click()
      await expect(think).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('.think-content')).toBeHidden()
    }
    await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).busy))
      .toBe(false)
    await think.click()
    await think.press('Space')
    await expect(think).toHaveAttribute('aria-expanded', 'false')
    await capture(`diagnostic-thinking-collapsed-${width}`)
  })

test('diagnostic: three approved bash calls in one response finish without a stuck queue', async () => {
  await run('/batch-fixture', '批量命令失败后继续')
  try {
    for (let i = 0; i < 3; i++) {
      await test.step(`approve command ${i + 1}`, async () => {
        await page
          .locator('.approval-card')
          .getByRole('button', { name: '允许一次', exact: true })
          .first()
          .click({ timeout: 8000 })
      })
    }
    await expect
      .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 10000 })
      .toBe(false)
    await expect(page.locator('.assistant-node').last()).toContainText('BATCH_COMPLETE')
  } finally {
    const summary = page.locator('.work-summary-trigger').last()
    if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
    await capture('diagnostic-batch-tools')
  }
})

for (const mode of ['pair', 'separate'])
  test(`diagnostic: ${mode} two successful bash calls complete`, async () => {
    await run(`/${mode}-fixture`, '两条成功命令')
    for (let i = 0; i < 2; i++) {
      await page
        .locator('.approval-card')
        .getByRole('button', { name: '允许一次', exact: true })
        .first()
        .click()
    }
    try {
      await expect
        .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 5000 })
        .toBe(false)
      await expect(page.locator('.assistant-node').last()).toContainText('PAIR_COMPLETE')
    } finally {
      await page.locator('.work-summary-trigger').last().click()
      await capture(`diagnostic-minimal-${mode}`)
    }
  })

test('diagnostic: stop interrupts a same-response mutation wait', async () => {
  // Keep a real mutation running rather than racing Stop against two completed printf calls.
  await run('/slow-batch-fixture', '停止等待的命令')
  await page.locator('.approval-card')
    .getByRole('button', { name: '允许一次', exact: true }).first().click()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).nodes.some(
    node => node.type === 'tool' && node.toolCallId === 'slow-first' && node.status === 'running'
  ))).toBe(true)
  await page.getByRole('button', { name: '停止当前运行', exact: true }).click()
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 5000 })
    .toBe(false)
  await run('/separate-fixture', '停止后重新执行')
  for (let i = 0; i < 2; i++) {
    await page
      .locator('.approval-card')
      .getByRole('button', { name: '允许一次', exact: true })
      .first()
      .click({ timeout: 8000 })
  }
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).busy), { timeout: 5000 })
    .toBe(false)
})

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
    await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0 })
    if (await page.locator('.approval-jump').count()) await page.locator('.approval-jump').click()
    else await approval.focus()
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
