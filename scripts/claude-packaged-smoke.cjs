// Runs the actual packaged hosts and bundled SDKs without opening the production workbench.
const { app, utilityProcess } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const root = mkdtempSync(join(tmpdir(), 'desktop-packaged-sdk-'))
app.setPath('userData', join(root, 'user-data'))
let host, fixture
const pending = new Map()
let latest
let sequence = 0
async function request(command) {
  const requestId = `packaged-${++sequence}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Timed out: ${command.type}`))
    }, 20000)
    pending.set(requestId, { resolve, reject, timeout })
    host.postMessage({ ...command, requestId })
  })
}
async function startHost(asar, script, storage) {
  host = utilityProcess.fork(join(asar, 'out/main', script), [], {
    env: {
      ...process.env,
      PI_DESKTOP_E2E: '0',
      PI_DESKTOP_RUNTIME_STORAGE: JSON.stringify(storage),
      PI_DESKTOP_RUNTIME_ROLE: 'session'
    },
    stdio: 'pipe'
  })
  host.stderr.on('data', (chunk) => process.stderr.write(chunk))
  host.on('exit', (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(new Error(`Packaged host exited: ${code}`))
    }
    pending.clear()
  })
  host.on('message', (message) => {
    if (message.type === 'event' && message.event === 'snapshot') latest = message.data
    if (message.type !== 'response') return
    const callback = pending.get(message.requestId)
    if (!callback) return
    pending.delete(message.requestId)
    clearTimeout(callback.timeout)
    message.ok ? callback.resolve(message.data) : callback.reject(new Error(message.error))
  })
  await new Promise((resolve, reject) => {
    host.once('spawn', resolve)
    host.once('error', reject)
  })
}
async function run() {
  const asar = resolve(
    process.argv[2] || 'dist/mac-arm64/Pi Desktop.app/Contents/Resources/app.asar'
  )
  assert.ok(existsSync(asar), `Package is missing: ${asar}`)
  const fixturePath = join(root, 'fixture.cjs')
  writeFileSync(
    fixturePath,
    buildSync({
      entryPoints: [resolve('src/claude-host/sdk-fixture.ts')],
      platform: 'node',
      bundle: true,
      format: 'cjs',
      write: false
    }).outputFiles[0].text
  )
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  fixture = await require(fixturePath).createClaudeHttpFixture({ cwd })
  const storage = Object.fromEntries(
    ['config', 'sessions', 'state', 'cache'].map((key) => [key, join(root, key)])
  )
  for (const directory of Object.values(storage)) mkdirSync(directory)
  await startHost(asar, 'claude-host.js', storage)
  const boot = await request({ type: 'bootstrap' })
  assert.equal(boot.snapshot.runtime.id, 'claude')
  assert.ok(boot.snapshot.models.length > 2)
  await request({
    type: 'account:api-key:set',
    providerId: 'anthropic',
    apiKey: 'fixture-key',
    baseUrl: fixture.baseUrl
  })
  const opened = await request({ type: 'project:open', cwd })
  await request({
    type: 'prompt:send',
    text: 'hello fixture',
    sessionId: opened.snapshot.sessionId,
    generation: opened.snapshot.generation
  })
  const started = Date.now()
  while (
    !latest ||
    latest.busy ||
    !latest.nodes.some(
      (node) => node.type === 'assistant' && node.markdown.includes('Claude fixture reply.')
    )
  ) {
    if (Date.now() - started > 20000)
      throw new Error('Packaged SDK did not complete its real native query')
    await new Promise((resolve) => setTimeout(resolve, 50))
    latest = (await request({ type: 'state:get' })).snapshot
  }
  assert.ok(latest.activeSessionPath.startsWith(storage.sessions))
  assert.ok(fixture.requests.some((request) => request.path.includes('/messages')))
  await request({ type: 'runtime:shutdown' })
  process.stdout.write(
    `Packaged Claude SDK smoke passed: models=${boot.snapshot.models.length}, native session and real HTTP stream verified.\n`
  )
  await new Promise((resolve) => {
    host.once('exit', resolve)
    host.kill()
  })
  const piStorage = Object.fromEntries(
    ['config', 'sessions', 'state', 'cache'].map((key) => [key, join(root, 'pi', key)])
  )
  for (const directory of Object.values(piStorage)) mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(piStorage.config, 'auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-key' } })
  )
  writeFileSync(
    join(piStorage.config, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: fixture.baseUrl,
          api: 'anthropic-messages',
          models: [
            {
              id: 'claude-smoke',
              name: 'Owned Pi fixture',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192
            }
          ]
        }
      }
    })
  )
  await startHost(asar, 'agent-host.js', piStorage)
  const piBoot = await request({ type: 'bootstrap' })
  assert.equal(piBoot.snapshot.runtime.id, 'pi')
  assert.equal(piBoot.snapshot.agentDir, piStorage.config)
  assert.ok(
    piBoot.snapshot.models.some(
      (model) => model.provider === 'fixture' && model.id === 'claude-smoke'
    )
  )
  const piOpened = await request({ type: 'project:open', cwd })
  await request({ type: 'model:set', providerId: 'fixture', modelId: 'claude-smoke' })
  await request({
    type: 'prompt:send',
    text: 'hello fixture',
    sessionId: piOpened.snapshot.sessionId,
    generation: piOpened.snapshot.generation
  })
  const piStarted = Date.now()
  do {
    latest = (await request({ type: 'state:get' })).snapshot
    if (latest.status === 'error') throw new Error(JSON.stringify(latest.nodes))
    if (Date.now() - piStarted > 20000)
      throw new Error('Packaged Pi did not complete its real HTTP stream')
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (
    latest.busy ||
    !latest.nodes.some(
      (node) => node.type === 'assistant' && node.markdown.includes('Claude fixture reply.')
    )
  )
  assert.ok(latest.activeSessionPath.startsWith(piStorage.sessions))
  await request({ type: 'runtime:shutdown' })
  process.stdout.write(
    'Packaged Pi smoke passed: app-owned config, JSONL session root and real HTTP stream verified.\n'
  )
}
app
  .whenReady()
  .then(run)
  .then(
    () => finish(0),
    (error) => {
      process.stderr.write(`${error.stack || error}\n`)
      finish(1)
    }
  )
async function finish(code) {
  host?.kill()
  await fixture?.close()
  rmSync(root, { recursive: true, force: true })
  app.exit(code)
}
