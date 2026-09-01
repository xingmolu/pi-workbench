const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { app } = require('electron')

const isolatedUserData = mkdtempSync(join(tmpdir(), 'pi-desktop-electron-store-'))
app.setPath('userData', isolatedUserData)

void app
  .whenReady()
  .then(async () => {
    const builtInterop = require(resolve(__dirname, '../out/main/electron-store-interop.js'))
    const Store = await builtInterop.loadElectronStoreConstructor()
    const store = new Store({ name: 'interop-smoke' })
    store.set('constructorWorks', true)
    if (store.get('constructorWorks') !== true) {
      throw new Error('electron-store smoke value did not round-trip')
    }
    process.stdout.write('electron-store built-main smoke passed\n')
  })
  .then(
    () => 0,
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      return 1
    }
  )
  .then((exitCode) => {
    rmSync(isolatedUserData, { force: true, recursive: true })
    app.exit(exitCode)
  })
