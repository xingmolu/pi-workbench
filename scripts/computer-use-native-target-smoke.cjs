// Read-only macOS target-identity smoke. It never captures pixels or posts input.
// Run after npm run build:native:mac on an unlocked desktop.
const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')

const helper = resolve(process.argv[2] || 'resources/native/pi-computer-use-helper')

function call(command) {
  try {
    return JSON.parse(
      execFileSync(helper, [JSON.stringify(command)], {
        encoding: 'utf8',
        timeout: 8000
      })
    )
  } catch (error) {
    if (error.stdout) return JSON.parse(String(error.stdout))
    throw error
  }
}

const lock = call({ action: 'session-lock' })
if (lock.locked) {
  process.stderr.write('Desktop is locked; target smoke blocked.\n')
  process.exitCode = 2
} else {
  const foreground = call({ action: 'foreground-window' })
  assert.equal(foreground.ok, true, 'Foreground target must be unique')
  const target = foreground.target
  const x = target.frame.x + target.frame.width / 2
  const y = target.frame.y + target.frame.height / 2
  assert.deepEqual(call({ action: 'validate-target', expectedTarget: target, x, y }), { ok: true })
  assert.equal(
    call({
      action: 'validate-target',
      expectedTarget: {
        ...target,
        windowId: target.windowId + 1
      },
      x,
      y
    }).error,
    'target-changed'
  )
  assert.equal(
    call({ action: 'validate-target', expectedTarget: target, expiresAt: Date.now() - 1000, x, y })
      .error,
    'visual-state-expired'
  )
  process.stdout.write('Foreground target, mismatch rejection, and expiry checks passed.\n')
}
