import { _electron as electron, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('MCP settings loads and unlocks after development StrictMode effect replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-strict-'))
  const entry = join(dir, 'main.cjs')
  await writeFile(
    entry,
    `const {app,BrowserWindow}=require('electron');
    app.setPath('userData', ${JSON.stringify(join(dir, 'data'))});
    app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank')});`
  )
  const app = await electron.launch({ args: [entry], env: { ...process.env, HOME: dir } })
  try {
    const page = await app.firstWindow()
    const bundle = await build({
      stdin: {
        contents: `
        import React, {StrictMode} from 'react';
        import {createRoot} from 'react-dom/client';
        import McpSettings from ${JSON.stringify(resolve('src/renderer/src/components/McpSettings.tsx'))};
        window.mcpReads=0;
        window.pi={send:async()=>{window.mcpReads++;await new Promise(r=>setTimeout(r,25));return {kind:'mcp',result:{revision:'fixture',writable:true,servers:[]}}}};
        createRoot(document.getElementById('root')).render(<StrictMode><McpSettings snapshot={{ready:true,sessionId:null,generation:0,busy:false,project:null,queuedCount:0,login:{phase:'idle'},approvals:[],followUp:[]}}/></StrictMode>);
      `,
        loader: 'tsx',
        resolveDir: resolve('.')
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.css': 'empty' }
    })
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await expect(page.getByRole('heading', { name: '还没有 MCP 服务器' })).toBeVisible()
    await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '新建', exact: true })).toBeEnabled()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { mcpReads: number }).mcpReads))
      .toBe(2)
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { mcpReads: number }).mcpReads))
      .toBe(3)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
