// Isolated integration fixture only; copied next to the renamed production utility bundle.
// No production entry imports this script or exposes a fault-injection command.
if (!process.parentPort || !process.argv.includes('--isolated-terminal-fixture')) {
  throw new Error('Requires an isolated terminal utility fixture')
}
const fs = require('node:fs')
const path = require('node:path')
const originalWrite = fs.write
fs.write = (...args) => {
  fs.write = originalWrite
  const callback = args[args.length - 1]
  const error = new Error('PRIVATE_TERMINAL_IO_FIXTURE_SENTINEL')
  error.code = 'EIO'
  setImmediate(() => callback(error, 0, args[1]))
}
require(path.join(__dirname, 'terminal-host-production.js'))
