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

const artifacts = resolve('artifacts/e2e/coding-flow')
const SOURCE = `export function total(items: { price: number; qty: number }[]): number {
  let sum = 0
  for (const item of items) {
    sum += item.price
  }
  return sum
}

export function format(value: number): string {
  return '$' + value
}
`

let app: ElectronApplication, page: Page, root: string, project: string
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-coding-flow-')))
  project = join(root, 'shop')
  const agent = join(root, 'agent')
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(root, 'home')),
    mkdir(join(root, 'user-data')),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(artifacts, { recursive: true })
  ])
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
  const file = join(project, 'src', 'cart.ts')
  const test = join(project, 'src', 'cart.test.ts')
  const answer = [
    '已修复 `total()` 漏乘数量的问题，并补了一个回归测试。',
    '',
    '**改动**',
    '- `src/cart.ts`：累加时使用 `item.price * item.qty`；`format()` 保留两位小数。',
    '- `src/cart.test.ts`：新增覆盖多件商品的用例。',
    '',
    '```ts',
    'sum += item.price * item.qty',
    '```',
    '',
    '| 用例 | 结果 |',
    '| --- | --- |',
    '| 单件商品 | 通过 |',
    '| 多件商品 | 通过 |'
  ].join('\n')
  await writeFile(
    join(agent, 'extensions', 'fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from ${JSON.stringify(publicAI)};
    export default function(pi) {
      const faux = fauxProvider({ provider:'coding-fixture', api:'coding-fixture-api', models:[{id:'offline',reasoning:true}], tokensPerSecond:400, tokenSize:{min:4,max:4} });
      pi.registerProvider(faux.provider);
      pi.registerCommand('coding-fixture', { description:'Offline coding flow', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxThinking('先看一下 cart.ts 的实现，确认合计逻辑。'), fauxToolCall('read', {path:${JSON.stringify(file)}}, {id:'read-cart'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('edit', {path:${JSON.stringify(file)}, edits:[
            {oldText:'    sum += item.price\\n', newText:'    sum += item.price * item.qty\\n'},
            {oldText:"  return '$' + value\\n", newText:"  return '$' + value.toFixed(2)\\n"}
          ]}, {id:'edit-cart'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('write', {path:${JSON.stringify(test)}, content:"import { total } from './cart'\\n\\ntest('multiplies quantity', () => {\\n  expect(total([{ price: 2, qty: 3 }])).toBe(6)\\n})\\n"}, {id:'write-test'})], {stopReason:'toolUse'}),
          fauxAssistantMessage([fauxToolCall('bash', {command:'printf "2 passed"'}, {id:'run-tests'})], {stopReason:'toolUse'}),
          fauxAssistantMessage(fauxText(${JSON.stringify(answer)}))
        ]);
      }});
      pi.registerCommand('rules-fixture', { description:'Offline command rule flow', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('bash', {command:'printf RULE_OK'}, {id:'rule-bash-' + Date.now()})], {stopReason:'toolUse'}),
          fauxAssistantMessage('命令已运行。')
        ]);
      }});
      pi.registerCommand('risky-fixture', { description:'Risky command', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('bash', {command:'git push'}, {id:'risky-' + Date.now()})], {stopReason:'toolUse'}),
          fauxAssistantMessage('已处理。')
        ]);
      }});
      pi.registerCommand('approval-fixture', { description:'Offline approval flow', handler:async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('edit', {path:${JSON.stringify(file)}, edits:[
            {oldText:'  let sum = 0\\n', newText:'  let sum = 0 // cents\\n'}
          ]}, {id:'edit-approval'})], {stopReason:'toolUse'}),
          fauxAssistantMessage('完成。')
        ]);
      }});
    }
  `
  )
  await writeFile(file, SOURCE)
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
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pi.getState()).models.some((m) => m.provider === 'coding-fixture')
      )
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'coding-fixture', modelId: 'offline' })
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

async function theme(value: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByLabel('主题', { exact: true }).selectOption(value)
  await expect(page.locator('html')).toHaveAttribute('data-theme', value)
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
}

test('agent file changes are visible in the conversation', async () => {
  await page.screenshot({ path: join(artifacts, 'empty-dark.png'), animations: 'disabled' })
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await run('/coding-fixture', 'total() 算出来的金额不对，帮我修一下并补个测试')
  await expect(page.locator('.assistant-node').last()).toContainText('回归测试')
  await page.screenshot({ path: join(artifacts, 'completed-dark.png'), animations: 'disabled' })
  const changes = page.locator('.turn-changes').last()
  await expect(changes).toContainText('2 个文件')
  await expect(changes).toContainText('cart.ts')
  await expect(changes).toContainText('cart.test.ts')

  await changes
    .getByRole('button', { name: /cart\.ts/ })
    .first()
    .click()
  const diff = changes.locator('.tool-change')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText('item.qty')
  await page.screenshot({ path: join(artifacts, 'turn-diff-dark.png'), animations: 'disabled' })

  await page.locator('.work-summary-trigger').last().click()
  await expect(page.locator('.work-summary-content').last()).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'work-dark.png'), animations: 'disabled' })
  await theme('dark')
  await page.screenshot({ path: join(artifacts, 'work-dark-theme.png'), animations: 'disabled' })
  await page.locator('.conversation-scroll').evaluate((el) => el.scrollTo(0, 0))
  await page.screenshot({ path: join(artifacts, 'top-dark-theme.png'), animations: 'disabled' })
})

test('approval shows the proposed diff before anything is written', async () => {
  await run('/approval-fixture', '在 sum 上加个单位注释')
  const card = page.locator('.approval-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.tool-change')).toContainText('cents')
  expect(await readFile(join(project, 'src', 'cart.ts'), 'utf8')).toBe(SOURCE)
  await page.screenshot({ path: join(artifacts, 'approval-dark.png'), animations: 'disabled' })
  await theme('light')
  await page.screenshot({ path: join(artifacts, 'approval-light.png'), animations: 'disabled' })
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(page.locator('.assistant-node').last()).toContainText('完成')
  expect(await readFile(join(project, 'src', 'cart.ts'), 'utf8')).toContain('// cents')
})

test('undo restores the files a turn changed and removes the ones it created', async () => {
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await run('/coding-fixture', 'total() 算出来的金额不对，帮我修一下并补个测试')
  await expect(page.locator('.assistant-node').last()).toContainText('回归测试')
  const cart = join(project, 'src', 'cart.ts')
  const created = join(project, 'src', 'cart.test.ts')
  expect(await readFile(cart, 'utf8')).toContain('item.qty')
  const changes = page.locator('.turn-changes').last()
  await changes.getByRole('button', { name: '撤销', exact: true }).click()
  const confirm = changes.getByRole('group', { name: '确认撤销' })
  await expect(confirm).toContainText('命令行产生的改动不会还原')
  await expect(confirm.locator('li')).toHaveCount(2)
  await expect(confirm.locator('li').nth(1)).toContainText('删除')
  await page.screenshot({ path: join(artifacts, 'undo-confirm.png'), animations: 'disabled' })
  await confirm.getByRole('button', { name: '撤销改动', exact: true }).click()
  await expect(changes).toContainText('已撤销 2 个文件')
  expect(await readFile(cart, 'utf8')).toBe(SOURCE)
  await expect(readFile(created, 'utf8')).rejects.toThrow()
  await expect(changes.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  await page.screenshot({ path: join(artifacts, 'undo-done.png'), animations: 'disabled' })
})

test('undo asks before overwriting files edited after the agent', async () => {
  await page.evaluate(() => window.pi.send({ type: 'permission:set', mode: 'open' }))
  await run('/coding-fixture', '修一下金额')
  await expect(page.locator('.assistant-node').last()).toContainText('回归测试')
  const cart = join(project, 'src', 'cart.ts')
  await writeFile(cart, 'edited by hand\n')
  const changes = page.locator('.turn-changes').last()
  await changes.getByRole('button', { name: '撤销', exact: true }).click()
  const confirm = changes.getByRole('group', { name: '确认撤销' })
  await expect(confirm.locator('li.is-conflict')).toContainText('之后被改动过')
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  expect(await readFile(cart, 'utf8')).toBe('edited by hand\n')
  await changes.getByRole('button', { name: '撤销', exact: true }).click()
  await confirm.getByRole('button', { name: '覆盖 1 个文件并撤销', exact: true }).click()
  await expect(changes).toContainText('已撤销 2 个文件')
  expect(await readFile(cart, 'utf8')).toBe(SOURCE)
})

test('always-allow turns an approval into a project rule the next run honors', async () => {
  await run('/rules-fixture', '跑一下检查')
  const card = page.locator('.approval-card')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '总是允许 printf', exact: true }).click()
  await expect(page.locator('.assistant-node').last()).toContainText('命令已运行')
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).permissionRules?.commands))
    .toEqual(['printf'])

  await run('/rules-fixture', '再跑一次')
  await expect(page.locator('.assistant-node')).toHaveCount(2)
  await expect(page.locator('.approval-card')).toHaveCount(0)
  await expect(page.locator('.tool-node').last()).toContainText('printf RULE_OK')

  const chip = page.locator('.composer .permission-chip')
  await expect(chip).toContainText('请求批准')
  await chip.click()
  const popover = page.getByRole('dialog', { name: '工具权限' })
  await popover.locator('summary').click()
  await expect(popover.locator('code')).toHaveText('printf')
  await popover.getByLabel('添加始终允许的命令').fill('npm test && rm x')
  await popover.getByRole('button', { name: '添加规则' }).click()
  await expect(popover.getByRole('alert')).toContainText('规则不能包含')
  await popover.getByLabel('添加始终允许的命令').fill('npm test')
  await popover.getByRole('button', { name: '添加规则' }).click()
  await expect(popover.locator('code')).toHaveText(['printf', 'npm test'])
  await page.screenshot({ path: join(artifacts, 'permission-popover.png'), animations: 'disabled' })
  await popover.getByRole('button', { name: '移除规则 printf' }).click()
  await expect(popover.locator('code')).toHaveText(['npm test'])
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(artifacts, 'composer-compact.png'), animations: 'disabled' })
})

test('"帮我批准" runs undoable project edits and routine commands, asks for risky ones, and is remembered', async () => {
  const chip = page.locator('.composer .permission-chip')
  await chip.click()
  const popover = page.getByRole('dialog', { name: '工具权限' })
  await expect(popover.getByRole('radio')).toHaveCount(3)
  await page.screenshot({ path: join(artifacts, 'permission-levels.png'), animations: 'disabled' })
  await popover.getByRole('radio', { name: /帮我批准/ }).click()
  await page.keyboard.press('Escape')
  await expect(chip).toContainText('帮我批准')

  await run('/coding-fixture', '修一下金额')
  await expect(page.locator('.assistant-node').last()).toContainText('回归测试')
  await expect(page.locator('.approval-card')).toHaveCount(0)
  expect(await readFile(join(project, 'src', 'cart.ts'), 'utf8')).toContain('item.qty')

  await run('/risky-fixture', '推送一下')
  await expect(page.locator('.approval-card')).toBeVisible()
  await expect(page.locator('.approval-card')).toContainText('git push')
  await page.locator('.approval-card').getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(page.locator('.assistant-node').last()).toContainText('已处理')

  const stored = JSON.parse(
    await readFile(join(root, 'agent', 'pi-desktop', 'permissions.json'), 'utf8')
  )
  expect(stored.modes[project]).toBe('auto')
})
