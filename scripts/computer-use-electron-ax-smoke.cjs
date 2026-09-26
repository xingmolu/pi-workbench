// Tests the real Swift AX reader against a controlled Electron app with AX initially off.
// Usage: node scripts/computer-use-electron-ax-smoke.cjs /absolute/path/to/helper
const { _electron } = require('@playwright/test')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
async function main() {
  const helper = path.resolve(process.argv[2])
  const permission = JSON.parse(
    execFileSync(helper, ['{"action":"accessibility-permission"}'], { encoding: 'utf8' })
  )
  assert(permission.trusted, 'The helper caller needs Accessibility permission')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cu-electron-'))
  let app
  try {
    app = await _electron.launch({
      args: [
        path.join(__dirname, 'fixtures/computer-use-electron-target.cjs'),
        `--user-data-dir=${root}`
      ]
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'CU_ELECTRON_DEEP_BUTTON' }).waitFor()
    const start = Date.now()
    const dump = JSON.parse(
      execFileSync(helper, ['{"action":"ax-dump"}'], { encoding: 'utf8', timeout: 8000 })
    )
    assert(dump.ok, 'AX dump must succeed')
    assert(
      dump.windows.some((w) => w.title === 'PI_CU_ELECTRON_TARGET'),
      'Only inspect the controlled foreground target'
    )
    const text = JSON.stringify(dump)
    const button = text.includes('CU_ELECTRON_DEEP_BUTTON')
    const input = text.includes('CU_ELECTRON_DEEP_INPUT')
    console.log(
      JSON.stringify({
        button,
        input,
        nodes: dump.nodeCount,
        truncated: dump.truncated,
        elapsedMs: Date.now() - start
      })
    )
    assert(
      button && input,
      'Electron deep web controls must be exposed without restarting the target'
    )
    assert(dump.nodeCount <= 160, 'Keep the node budget')
    const again = Date.now()
    const repeated = JSON.parse(
      execFileSync(helper, ['{"action":"ax-dump"}'], { encoding: 'utf8', timeout: 8000 })
    )
    assert(JSON.stringify(repeated).includes('CU_ELECTRON_DEEP_BUTTON'))
    assert(
      Date.now() - again < 2000,
      'An enabled web tree must not restart the two-second activation delay'
    )
    await page.setContent(
      '<title>PI_CU_ELECTRON_TARGET</title>' +
        '<div role="group" aria-label="deep">'.repeat(40) +
        '<button>BEYOND_DEPTH</button>' +
        '</div>'.repeat(40)
    )
    await page.getByRole('button', { name: 'BEYOND_DEPTH' }).waitFor()
    const bounded = JSON.parse(
      execFileSync(helper, ['{"action":"ax-dump"}'], { encoding: 'utf8', timeout: 8000 })
    )
    assert(bounded.truncated, 'Depth-limited trees must report truncation')
    assert(bounded.nodeCount <= 160)
    console.log(JSON.stringify({ repeat: true, depthLimit: true }))
  } finally {
    await app?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
