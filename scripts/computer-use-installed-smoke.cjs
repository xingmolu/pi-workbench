// Manual macOS smoke: an offline model drives a packaged app's real computer tool.
// This child launch does not establish standalone macOS TCC authorization.
// Run: node scripts/computer-use-installed-smoke.cjs '/path/to/Pi Desktop.app'
const { _electron: electron } = require('@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

async function main() {
  const bundle = path.resolve(process.argv[2] || '')
  assert(bundle.endsWith('.app'), 'Pass the packaged .app path')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cu-live-')))
  const home = path.join(root, 'home')
  const agent = path.join(home, '.pi/agent')
  const project = path.join(root, 'project')
  for (const directory of [path.join(agent, 'extensions'), project, path.join(root, 'profile')])
    await fs.mkdir(directory, { recursive: true })
  const ai = path.resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await fs.readFile(path.join(ai, 'package.json'), 'utf8'))
  await fs.writeFile(
    path.join(agent, 'auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-only' } })
  )
  await fs.writeFile(
    path.join(agent, 'extensions/computer-smoke.ts'),
    `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(path.resolve(ai, pkg.exports['.'].import))};
    export default function(pi) {
      const faux = fauxProvider({provider:'fixture',api:'fixture-api',models:[{id:'offline'}],tokensPerSecond:10000});
      const respond = async (context) => {
        const last = context.messages.at(-1);
        if (last?.role === 'toolResult') return fauxAssistantMessage(JSON.stringify({
          isError: !!last.isError, text: last.content.filter(x => x.type === 'text').map(x => x.text).join('\\n')
        }));
        const user = context.messages.filter(m => m.role === 'user').at(-1);
        const text = typeof user.content === 'string' ? user.content : user.content.filter(x => x.type === 'text').map(x => x.text).join('');
        return fauxAssistantMessage(fauxToolCall('computer', JSON.parse(text), {id:'native-' + context.messages.length}), {stopReason:'toolUse'});
      };
      faux.setResponses(Array(16).fill(respond)); pi.registerProvider(faux.provider);
    }
  `
  )
  const reportPath = path.resolve('artifacts/e2e/computer-use-live.json')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  const report = { bundle, startedAt: new Date().toISOString(), status: 'running' }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  let app
  let target
  try {
    app = await electron.launch({
      executablePath: path.join(bundle, 'Contents/MacOS/Pi Desktop'),
      args: [`--user-data-dir=${path.join(root, 'profile')}`],
      env: { PATH: process.env.PATH || '', HOME: home, LANG: 'en_US.UTF-8' }
    })
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      userData: app.getPath('userData')
    }))
    assert(identity.packaged, 'Must exercise a packaged app')
    assert.equal(identity.userData, path.join(root, 'profile'))
    const page = await app.firstWindow()
    async function until(read, predicate, limit = 30000) {
      const end = Date.now() + limit
      while (Date.now() < end) {
        const value = await read()
        if (predicate(value)) return value
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('Timed out waiting for packaged Computer Use')
    }
    const initial = await until(
      () => page.evaluate(() => window.pi.getState()),
      (state) => state.ready
    )
    assert.equal(initial.agentDir, agent, 'Agent settings must stay in the temporary home')
    const permission = await page.evaluate(() =>
      window.pi.desktopControl({ type: 'accessibility-permission' })
    )
    // Lock state is session-wide. Permission above is deliberately queried via
    // the packaged app's own IPC/helper so the TCC caller is the actual app.
    const lock = JSON.parse(
      require('node:child_process').execFileSync(
        path.join(bundle, 'Contents/Helpers/pi-computer-use-helper'),
        [JSON.stringify({ action: 'session-lock' })],
        { encoding: 'utf8', timeout: 8000 }
      )
    )
    console.log(
      JSON.stringify({
        packaged: true,
        launchContext: 'playwright-child',
        permission: permission.permission.access,
        locked: lock.locked
      })
    )
    await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
    await page.evaluate(() =>
      window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
    )
    async function runTool(operation) {
      const previous = await page.evaluate(() => window.pi.getState())
      const oldIds = previous.nodes
        .filter((node) => node.type === 'assistant')
        .map((node) => node.id)
      await page.evaluate(async (operation) => {
        const state = await window.pi.getState()
        await window.pi.send({
          type: 'prompt:send',
          text: JSON.stringify(operation),
          sessionId: state.sessionId,
          generation: state.generation
        })
      }, operation)
      const state = await until(
        async () => {
          const state = await page.evaluate(() => window.pi.getState())
          if (operation.action === 'act') {
            for (const approval of state.approvals)
              await page.evaluate(
                (id) => window.pi.send({ type: 'permission:respond', approvalId: id, allow: true }),
                approval.id
              )
          }
          return state
        },
        (state) =>
          !state.busy &&
          state.nodes.some((node) => node.type === 'assistant' && !oldIds.includes(node.id))
      )
      return JSON.parse(state.nodes.findLast((node) => node.type === 'assistant').markdown)
    }
    let result
    if (lock.locked || permission.permission.access !== 'granted') {
      result = await runTool({ action: 'observe', mode: 'semantic' })
      assert(result.isError, 'An unavailable native desktop must reject computer observe')
      console.log(
        JSON.stringify({ computerToolReached: true, observationBlocked: true, error: result.text })
      )
      process.exitCode = 2 // Environment blocked; never report full input success.
    } else {
      const binary = path.join(root, 'PiComputerUseTarget')
      require('node:child_process').execFileSync(
        'xcrun',
        ['swiftc', path.join(__dirname, 'fixtures/computer-use-target.swift'), '-o', binary],
        { timeout: 60000 }
      )
      target = require('node:child_process').spawn(binary, [], { stdio: 'ignore' })
      await new Promise((resolve) => setTimeout(resolve, 1200))
      async function success(operation) {
        const response = await runTool(operation)
        assert(!response.isError, response.text)
        return JSON.parse(response.text)
      }
      // AppKit can lazily expose titlebar accessibility children on its first read.
      await success({ action: 'observe', mode: 'semantic' })
      const observed = await success({ action: 'observe', mode: 'semantic' })
      assert(
        observed.elements.some((item) => item.title === 'PI_CU_SMOKE_TARGET'),
        'Only act on our controlled window'
      )
      const button = observed.elements.find((item) => item.title === 'CU_TEST_BUTTON')
      assert(button, 'Native AX button must be discoverable')
      const clicked = await success({
        action: 'act',
        stateId: observed.stateId,
        target: { kind: 'ref', ref: button.ref },
        intent: 'press'
      })
      assert(
        clicked.observation.elements.some((item) => item.value === 'CU_BUTTON_CLICKED'),
        'Verify native click effect'
      )
      const field = clicked.observation.elements.find((item) => item.role === 'AXTextField')
      assert(field, 'Native AX input must be discoverable')
      const typed = await success({
        action: 'act',
        stateId: clicked.observation.stateId,
        target: { kind: 'ref', ref: field.ref },
        intent: 'type',
        text: 'CU_TEST_123'
      })
      assert(
        typed.observation.elements.some((item) => item.value === 'CU_TEST_123'),
        'Verify native typing effect'
      )
      result = { observe: true, click: true, type: true }
      console.log(JSON.stringify(result))
    }
    Object.assign(report, {
      identity,
      permission,
      lock,
      result,
      status: process.exitCode === 2 ? 'blocked' : 'passed'
    })
  } catch (error) {
    Object.assign(report, { status: 'failed', error: error.message })
    throw error
  } finally {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    target?.kill()
    await app?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
