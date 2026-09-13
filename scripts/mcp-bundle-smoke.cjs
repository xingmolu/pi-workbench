// Development Electron harness; never changes the packaged application's E2E guard.
const { app, utilityProcess } = require('electron')
const { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-mcp-bundle-')))
for (const name of ['home', 'agent', 'user-data', 'tmp']) mkdirSync(join(root, name))
app.setPath('userData', join(root, 'user-data'))
app.setPath('sessionData', join(root, 'user-data'))
let host,
  timer,
  finished = false
function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  host?.kill()
  rmSync(root, { recursive: true, force: true })
  app.exit(code)
}
app
  .whenReady()
  .then(() => {
    const resources = resolve(process.argv[2] || '')
    const script = join(resources, 'app.asar/out/main/agent-host.js')
    if (!process.argv[2] || !existsSync(script))
      throw new Error('Pass a built app Contents/Resources directory')
    host = utilityProcess.fork(script, [], {
      stdio: 'pipe',
      env: {
        HOME: join(root, 'home'),
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        PI_DESKTOP_E2E: '1',
        PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent')
      }
    })
    timer = setTimeout(() => {
      process.stderr.write('Packaged MCP Host timed out\n')
      finish(1)
    }, 15000)
    host.stderr.on('data', (chunk) =>
      process.stderr.write(String(chunk).split(root).join('<fixture>'))
    )
    host.on('spawn', () => host.postMessage({ type: 'mcp:list', requestId: 'bundle-mcp' }))
    host.on('exit', () => {
      if (!finished) finish(1)
    })
    host.on('message', (message) => {
      if (message.type !== 'response' || message.requestId !== 'bundle-mcp') return
      if (
        !message.ok ||
        message.data?.kind !== 'mcp' ||
        !message.data.result.writable ||
        message.data.result.servers.length
      ) {
        process.stderr.write('Packaged MCP Host response failed validation\n')
        finish(1)
        return
      }
      process.stdout.write(
        'Packaged agent-host and MCP SDK dependencies loaded in utilityProcess; isolated mcp:list passed\n'
      )
      finish(0)
    })
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`)
    finish(1)
  })
