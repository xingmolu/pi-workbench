import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Mount the real component in an isolated Electron renderer. No account credential,
// production bridge, network request, or application bundle rewrite is involved.
test('quota discards late same-provider results across login and auth generation changes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-quota-e2e-')))
  let app: ElectronApplication | undefined
  try {
    await Promise.all(['home', 'agent', 'user-data'].map((p) => mkdir(join(root, p))))
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
        PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
        PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
      }
    })
    const opened = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      })
      await window.loadURL('data:text/html,<html><body><main id="root"></main></body></html>')
    })
    const page = await opened
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import AccountQuota from './src/renderer/src/components/AccountQuota';
        const root = createRoot(document.getElementById('root'));
        const pending = [];
        window.pi = { send: command => new Promise(resolve => pending.push({command,resolve})) };
        window.quotaFixture = {
          render(generation, loginActive) { root.render(React.createElement(AccountQuota, {
            account:{id:'openai-codex',name:'Fixture',connected:true,authType:'oauth',subscription:true,alias:false},
            authGeneration:generation,loginActive
          })); },
          count:()=>pending.length,
          resolve(index,generation,usedPercent) { pending[index].resolve({kind:'account-quota',quota:{
            providerId:pending[index].command.providerId,authGeneration:generation,state:'available',
            fetchedAt:'2026-09-11T00:00:00.000Z',windows:[{label:'主要额度',usedPercent}]
          }}); }
        }; window.quotaFixture.render(0,false);`,
        resolveDir: resolve('.'),
        loader: 'tsx'
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const refresh = page.getByRole('button', { name: '刷新额度' })
    await refresh.click()
    await expect.poll(() => page.evaluate('window.quotaFixture.count()')).toBe(1)
    await page.evaluate('window.quotaFixture.render(1,true)')
    await expect(refresh).toBeDisabled()
    await page.evaluate('window.quotaFixture.resolve(0,0,90)')
    await expect(page.getByText('剩余 10%', { exact: true })).toHaveCount(0)
    await page.evaluate('window.quotaFixture.render(2,false)')
    await expect(refresh).toBeEnabled()
    await refresh.click()
    await page.evaluate('window.quotaFixture.resolve(1,2,20)')
    await expect(page.getByText('剩余 80%', { exact: true })).toBeVisible()
    await page.evaluate('window.quotaFixture.render(3,true)')
    await expect(page.getByText('剩余 80%', { exact: true })).toHaveCount(0)
    await expect(refresh).toBeDisabled()
    await page.evaluate('window.quotaFixture.render(4,false)')
    await expect(refresh).toBeEnabled()
    await refresh.click()
    await page.evaluate('window.quotaFixture.resolve(2,2,99)')
    await expect(page.getByText('账号已更新，请重新刷新额度。')).toBeVisible()
    await expect(page.getByText('剩余 1%', { exact: true })).toHaveCount(0)
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
