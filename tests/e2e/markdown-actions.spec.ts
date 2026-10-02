import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentSnapshot } from '../../src/shared/contracts'
import { build as bundleFixture } from 'esbuild'
import { displayEnv } from './display-env'
let app: ElectronApplication, page: Page, root: string, state: AgentSnapshot
test('profile long-reply renderer CPU with and without streaming preview', async () => {
  test.skip(process.env.PI_DESKTOP_PERF_TEST !== '1', 'Opt-in synthetic CPU comparison')
  const source = '| Name | Value | Code |\n| --- | --- | --- |\n' +
    '| alpha | **value** | `snippet` |\n'.repeat(500)
  const results: unknown[] = []
  for (const mode of ['idle', 'full-markdown', 'streaming-preview'] as const) {
    await publish(source, mode === 'streaming-preview')
    // Measure the same growing source at the merged 80 ms cadence. Full-markdown
    // forces the previous parse path; it is a synthetic comparison, not a model run.
    const result = await app.evaluate(async ({ app: electronApp, BrowserWindow }, data) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const rendererPid = contents.getOSProcessId()
      const before = electronApp.getAppMetrics().find(item => item.pid === rendererPid)
      const started = Date.now()
      let updates = 0
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          updates++
          if (data.mode !== 'idle') contents.send('pi:event', {
            type: 'event', event: 'snapshot', data: {
              ...data.state, revision: data.state.revision + updates,
              nodes: [{ id: 'table', type: 'assistant', markdown: data.source + '\n' + updates,
                streaming: data.mode === 'streaming-preview' }]
            }
          })
          if (updates === 50) { clearInterval(timer); resolve() }
        }, 80)
      })
      const metric = electronApp.getAppMetrics().find(item => item.pid === rendererPid)
      const cpuBefore = before?.cpu.cumulativeCPUUsage
      const cpuAfter = metric?.cpu.cumulativeCPUUsage
      return { mode: data.mode, updates, elapsedMs: Date.now() - started,
        cpuSeconds: typeof cpuAfter === 'number' && typeof cpuBefore === 'number' ? cpuAfter - cpuBefore : null,
        cpu: metric?.cpu, memory: metric?.memory }
    }, { mode, source, state })
    state.revision += 100
    results.push(result)
  }
  // Measure after completion so sustained CPU work cannot hide behind the stream.
  await publish(source, false)
  await expect(page.locator('.markdown-streaming-preview')).toHaveCount(0)
  await expect(page.locator('.assistant-node table')).toBeVisible()
  const afterCompletion = await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
    const before = electronApp.getAppMetrics().find(item => item.pid === rendererPid)
    await new Promise(resolve => setTimeout(resolve, 4000))
    const after = electronApp.getAppMetrics().find(item => item.pid === rendererPid)
    return { mode: 'idle-after-completion',
      cpuSeconds: typeof before?.cpu.cumulativeCPUUsage === 'number' && typeof after?.cpu.cumulativeCPUUsage === 'number'
        ? after.cpu.cumulativeCPUUsage - before.cpu.cumulativeCPUUsage : null }
  })
  results.push(afterCompletion)
  console.log('MARKDOWN_PERF', JSON.stringify(results))
  expect(afterCompletion.cpuSeconds).not.toBeNull()
  expect(afterCompletion.cpuSeconds!).toBeLessThan(0.4)
})
test('long streaming Markdown keeps formatting and flushes the final text', async () => {
  const source = '| Name | Value | Code |\n| --- | --- | --- |\n' +
    '| alpha | **value** | `snippet` |\n'.repeat(500)
  await publish(source, true)
  const preview = page.locator('.markdown-streaming-preview')
  await expect(preview).toHaveCount(0)
  await expect(page.locator('.assistant-node table')).toBeVisible()
  const updated = source + '\n[reference][target]\n\n[target]: https://example.com\n'
  await publish(updated, true)
  await expect(page.getByRole('link', { name: 'reference', exact: true })).toHaveAttribute('href', 'https://example.com')
  await page.screenshot({ path: 'artifacts/e2e/streaming-markdown.png' })
  await publish(updated)
  await expect(preview).toHaveCount(0)
  await expect(page.locator('.assistant-node table')).toBeVisible()
  await expect(page.getByRole('link', { name: 'reference', exact: true })).toHaveAttribute('href', 'https://example.com')
  // Replacing a long stream with a short reply must not leave a stale preview.
  await publish('**short reply**', true)
  await expect(page.locator('.assistant-node strong')).toHaveCount(1)
  await expect(page.locator('.assistant-node strong')).toHaveText('short reply')
})
test('code highlighting finishes after streaming and preserves exact copied source', async () => {
  const code = '\tconst count: number = 42  \n\n'
  await publish('```ts\n' + code + '\n```', true)
  const block = page.locator('.highlighted-code')
  await expect(block).toHaveAttribute('data-highlighted', 'false')
  await publish('```ts\n' + code + '\n```')
  await expect(block).toHaveAttribute('data-highlighted', 'true')
  expect(await block.textContent()).toBe(code)
  expect(await block.locator('span[style]').count()).toBeGreaterThan(3)
  await page.getByRole('button', { name: '复制代码', exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { markdownClipboard: { values: string[] } }).markdownClipboard.values.at(-1))).toBe(code)
  await page.screenshot({ path: 'artifacts/e2e/code-highlight.png' })
  await publish('```unknown\n<script>window.inert = false</script>\n```')
  await expect(block).toHaveAttribute('data-highlighted', 'false')
  await expect(block).toHaveText('<script>window.inert = false</script>')
  await expect(block.locator('script')).toHaveCount(0)
  await publish('```ts\n' + 'x'.repeat(4001) + '\n```')
  await expect(block).toHaveAttribute('data-highlighted', 'false')
  expect(await block.textContent()).toBe('x'.repeat(4001))
  // Replace a highlighted language/source quickly; an old worker response may
  // never recolor or restore the stale block.
  await publish('```python\nprint("old")\n```')
  await publish('```unknown\nCURRENT\n```')
  await expect(block).toHaveText('CURRENT')
  await expect(block).toHaveAttribute('data-highlighted', 'false')
})
test('code wrap overrides survive stream completion independently for each fence and message', async () => {
  const source = '引导正文\n\n```js\nconst first = 1\n```\n\n中间正文\n\n```js\nconst second = 2\n```'
  await publish(source, true)
  const wraps = page.getByRole('button', { name: '自动换行', exact: true })
  await expect(wraps).toHaveCount(2)
  await expect(wraps.nth(0)).toHaveAttribute('aria-pressed', 'false')
  await expect(wraps.nth(1)).toHaveAttribute('aria-pressed', 'false')
  await wraps.nth(0).click()
  await expect(wraps.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await publish(source)
  await expect(page.locator('.highlighted-code').first()).toHaveAttribute('data-highlighted', 'true')
  await expect(wraps.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(wraps.nth(1)).toHaveAttribute('aria-pressed', 'false')
  await publish(source + '\n\n继续输出', true)
  await expect(page.locator('.assistant-node')).toContainText('继续输出')
  await expect(wraps.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(wraps.nth(1)).toHaveAttribute('aria-pressed', 'false')
  await wraps.nth(1).click()
  await expect(wraps.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await publish(source, false, 'another-message')
  await expect(wraps.nth(0)).toHaveAttribute('aria-pressed', 'false')
  await expect(wraps.nth(1)).toHaveAttribute('aria-pressed', 'false')
})

async function publish(markdown: string, streaming = false, identity = 'table'): Promise<void> {
  state.revision++
  // Match Host projection: only finished actionable replies have canonical identity.
  state.nodes = [{ id: identity, type: 'assistant', markdown, streaming,
    ...(!streaming ? { canonicalEntryId: `${identity}-reply` } : {}) }]
  await app.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pi:event', {
      type: 'event',
      event: 'snapshot',
      data
    })
  }, state)
  await expect(page.locator('.assistant-node')).toBeVisible()
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-markdown-e2e-')))
  for (const name of ['home', 'agent', 'user-data', 'project']) await mkdir(join(root, name))
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  app = await electron.launch({
    args: [resolve('.')],
    cwd: root,
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      PI_CODING_AGENT_DIR: join(root, 'agent')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  const initial = await page.evaluate(() => window.pi.getState())
  state = {
    ...initial,
    generation: initial.generation + 100,
    revision: 1,
    sessionId: 'table-fixture',
    project: { path: join(root, 'project'), name: '表格测试' },
    activeModel: 'fixture',
    activeProvider: 'review',
    modelAvailability: 'available',
    composeBlockReason: null,
    accounts: [
      {
        id: 'review',
        name: '隔离测试账号',
        authType: 'api_key',
        connected: true,
        subscription: false,
        alias: false
      }
    ],
    models: [
      {
        provider: 'review',
        id: 'fixture',
        name: '测试模型（无网络）',
        contextWindow: 32000,
        reasoning: false
      }
    ],
    nodes: []
  }
  await page.evaluate(() => {
    const fixture = { values: [] as string[], mode: 'success', finish: () => {} }
    Object.assign(window, { markdownClipboard: fixture })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          fixture.values.push(text)
          return fixture.mode === 'reject'
            ? Promise.reject(new Error('fixture'))
            : fixture.mode === 'pending'
              ? new Promise<void>((resolve) => {
                  fixture.finish = resolve
                })
              : Promise.resolve()
        }
      }
    })
  })
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})
test('table protected/raw copy, native save and frozen paginated preview', async () => {
  const source = '| 名称 | 值 |\n|---|---|\n| 苹果 | 00123 |\n| 公式 | =1+1 |'
  await publish(source)
  await page.getByRole('button', { name: '复制表格', exact: true }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { markdownClipboard: { values: string[] } }).markdownClipboard.values
    )
  ).toEqual(["'名称\t'值\r\n'苹果\t'00123\r\n'公式\t'=1+1"])
  await page.getByRole('combobox', { name: '导出方式' }).selectOption('raw')
  await expect(page.getByText('原始值可能被表格软件解释为公式', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '复制 CSV', exact: true }).click()
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { markdownClipboard: { values: string[] } }
      ).markdownClipboard.values.at(-1)
    )
  ).toBe('"名称","值"\r\n"苹果","00123"\r\n"公式","=1+1"')
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
  })
  await page.getByRole('button', { name: '保存 CSV', exact: true }).click()
  await expect(page.getByText('已取消保存', { exact: true })).toBeVisible()
  const filePath = join(root, 'result.csv')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, filePath)
  await page.getByRole('button', { name: '保存 CSV', exact: true }).click()
  await expect(page.getByText('CSV 已保存', { exact: true })).toBeVisible()
  expect(await readFile(filePath, 'utf8')).toBe(
    '\uFEFF"名称","值"\r\n"苹果","00123"\r\n"公式","=1+1"'
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  await page.screenshot({ path: 'artifacts/e2e/markdown-actions.png' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 1000))
  await page.screenshot({ path: 'artifacts/e2e/markdown-actions-960.png' })
  const long =
    '| 名称 | 值 |\n|---|---|\n' +
    Array.from({ length: 205 }, (_, i) => `| row${i} | ${i} |`).join('\n')
  await publish(long, true)
  await page.getByRole('button', { name: '预览表格', exact: true }).click()
  const preview = page.getByRole('region', { name: '表格只读预览', exact: true })
  await expect(preview).toBeFocused()
  expect(
    await preview.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top >= 0 && rect.top < innerHeight
    })
  ).toBe(true)
  await expect(preview.locator('tr')).toHaveCount(200)
  await publish(long + '\n| appended | later |', true)
  await expect(preview).toContainText('已捕获流式输出当前快照')
  await preview.getByRole('button', { name: /加载后/ }).click()
  await expect(preview.locator('tr')).toHaveCount(206)
  await expect(preview).not.toContainText('appended')
  await page.screenshot({ path: 'artifacts/e2e/markdown-preview.png' })
  await preview.getByRole('button', { name: '关闭预览' }).click()
  await expect(page.getByRole('button', { name: '预览表格', exact: true })).toBeFocused()
})
test('copy failures and stale completion stay local; unsafe URLs and oversized source are inert', async () => {
  await publish('| A |\n|---|\n| B |')
  await page.evaluate(() => {
    ;(window as unknown as { markdownClipboard: { mode: string } }).markdownClipboard.mode =
      'reject'
  })
  await page.getByRole('button', { name: '复制表格', exact: true }).click()
  await expect(page.getByText('复制失败，请重试或选中表格手动复制。')).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as { markdownClipboard: { mode: string } }).markdownClipboard.mode =
      'pending'
  })
  await page.getByRole('button', { name: '复制表格', exact: true }).click()
  await publish('| A |\n|---|\n| changed |')
  await expect(page.locator('.markdown-table td')).toHaveText('changed')
  await page.evaluate(() => {
    ;(window as unknown as { markdownClipboard: { finish: () => void } }).markdownClipboard.finish()
  })
  await expect(page.getByRole('button', { name: '复制表格', exact: true })).toBeVisible()
  await publish(
    '[relative](/file) [protocol](//example.com) [file](file:///tmp/x) [ok](https://example.com)\n\n<script>window.bad=true</script>\n\n```html\n<svg onload="alert(1)"></svg>\n```'
  )
  for (const label of ['relative', 'protocol', 'file'])
    await expect(page.getByText(label, { exact: true })).not.toHaveAttribute('href')
  await expect(page.getByRole('link', { name: 'ok', exact: true })).toHaveAttribute(
    'rel',
    'noopener noreferrer'
  )
  await expect(page.locator('.assistant-node svg:not(.lucide)')).toHaveCount(0)
  await expect(page.locator('.assistant-node svg[onload]')).toHaveCount(0)
  await page.setViewportSize({ width: 960, height: 1000 })
  await publish('```\n' + 'x'.repeat(10000) + '\n```')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const huge = '文字'.repeat(40000)
  await publish(huge)
  await expect(page.getByText('内容较长，以下以完整纯文本显示。')).toBeVisible()
  await expect(page.locator('.markdown-plain-fallback')).toHaveText(huge)
})

test('many code blocks and 200+ table rows remain actionable without page overflow', async () => {
  const source = Array.from(
    { length: 30 },
    (_, index) =>
      `## 结果 ${index}\n\n\`\`\`txt\n${'long '.repeat(100)}\n\`\`\`\n\n| A | B |\n|---|---|\n${Array.from({ length: 7 }, (_, row) => `| ${index}-${row} | 内容 |`).join('\n')}`
  ).join('\n\n')
  const started = Date.now()
  await publish(source)
  await expect(page.locator('.markdown-table-result')).toHaveCount(30)
  await expect(page.locator('.code-block')).toHaveCount(30)
  await expect(page.locator('.markdown-table tr')).toHaveCount(240)
  const elapsed = Date.now() - started
  test.info().annotations.push({
    type: 'measurement',
    description: `Synthetic IPC to 30 code blocks + 240 table rows: ${elapsed} ms (isolated Electron, whole Markdown parse)`
  })
  expect(elapsed).toBeLessThan(10000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 1000))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '预览表格', exact: true }).first().click()
  await expect(page.getByRole('region', { name: '表格只读预览', exact: true })).toBeFocused()
})

test('export IPC rejects a non-app page even when it has the trusted preload', async () => {
  const result = await app.evaluate(async ({ BrowserWindow, dialog }, preload) => {
    let dialogs = 0
    dialog.showSaveDialog = async () => {
      dialogs++
      return { canceled: true, filePath: '' }
    }
    const outsider = new BrowserWindow({
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    try {
      await outsider.loadURL('about:blank')
      const response = await outsider.webContents.executeJavaScript(
        "window.pi.exportMarkdownTable({mode:'raw',cells:[['synthetic']]})"
      )
      return { response, dialogs }
    } finally {
      outsider.destroy()
    }
  }, resolve('out/preload/index.js'))
  expect(result).toEqual({
    response: { status: 'failed', message: '无法从此窗口保存表格。' },
    dialogs: 0
  })
})

test('save outcomes remain visible after clipboard failure and full reply success is announced', async () => {
  await publish('| A |\n|---|\n| B |')
  await page.evaluate(() => {
    ;(window as unknown as { markdownClipboard: { mode: string } }).markdownClipboard.mode =
      'reject'
  })
  await page.getByRole('button', { name: '复制表格', exact: true }).click()
  await expect(page.getByText('复制失败，请重试或选中表格手动复制。')).toBeVisible()
  for (const outcome of ['saved', 'cancelled', 'failed']) {
    await app.evaluate(
      ({ dialog }, data) => {
        dialog.showSaveDialog = async () => ({
          canceled: data.outcome === 'cancelled',
          filePath: data.filePath
        })
      },
      {
        outcome,
        filePath: outcome === 'failed' ? join(root, 'missing', 'out.csv') : join(root, 'out.csv')
      }
    )
    await page.getByRole('button', { name: '保存 CSV', exact: true }).click()
    await expect(page.getByRole('status', { name: '表格保存结果' })).toHaveText(
      outcome === 'saved'
        ? 'CSV 已保存'
        : outcome === 'cancelled'
          ? '已取消保存'
          : '保存失败，文件可能已更改，请重新选择保存位置。'
    )
  }
  await page.evaluate(() => {
    ;(window as unknown as { markdownClipboard: { mode: string } }).markdownClipboard.mode =
      'success'
  })
  await page.getByRole('button', { name: '复制回复', exact: true }).click()
  await expect(page.getByRole('status', { name: '回复复制结果' })).toHaveText('回复已复制')
})

test('reused message IDs do not receive pending clipboard results from a prior session', async () => {
  const source = '| A |\n|---|\n| B |'
  for (const name of ['复制表格', '复制回复']) {
    await publish(source)
    await page.evaluate(() => {
      ;(window as unknown as { markdownClipboard: { mode: string } }).markdownClipboard.mode =
        'pending'
    })
    await page.getByRole('button', { name, exact: true }).click()
    state.sessionId += '-next'
    await publish(source)
    await page.evaluate(async () => {
      ;(
        window as unknown as { markdownClipboard: { finish: () => void } }
      ).markdownClipboard.finish()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    })
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled()
    await expect(
      page.locator('.assistant-node [role="status"]').filter({ hasText: '已复制' })
    ).toHaveCount(0)
  }
})

test('late save success or rejection cannot fill replaced content or another session', async () => {
  for (const swap of ['content', 'session'])
    for (const reject of [false, true]) {
      await publish('| A |\n|---|\n| before |')
      await app.evaluate(
        ({ dialog }, filePath) => {
          const pending = { finish: (_reject: boolean) => {} }
          Object.assign(globalThis, { markdownDialog: pending })
          dialog.showSaveDialog = () =>
            new Promise<{ canceled: boolean; filePath: string }>((resolve, reject) => {
              pending.finish = (fail) =>
                fail
                  ? reject(new Error('synthetic dialog failure'))
                  : resolve({ canceled: false, filePath })
            })
        },
        join(root, 'late.csv')
      )
      await page.getByRole('button', { name: '保存 CSV', exact: true }).click()
      if (swap === 'session') state.sessionId += '-next'
      const currentValue = swap === 'session' ? 'before' : 'after'
      await publish(`| A |\n|---|\n| ${currentValue} |`)
      await expect(page.locator('.markdown-table td')).toHaveText(currentValue)
      await app.evaluate((_electron, reject) => {
        ;(
          globalThis as unknown as { markdownDialog: { finish: (reject: boolean) => void } }
        ).markdownDialog.finish(reject)
      }, reject)
      // A new same-window export is rejected while the old request owns Main's
      // slot. Its eventual cancelled reply is a round-trip barrier after the old
      // save/rejection finished; then let React commit the delivered old reply.
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
      })
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (
                await window.pi.exportMarkdownTable({
                  mode: 'raw',
                  cells: [['completion barrier']]
                })
              ).status
          )
        )
        .toBe('cancelled')
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      if (!reject)
        expect(await readFile(join(root, 'late.csv'), 'utf8')).toBe('\uFEFF"\'A"\r\n"\'before"')
      await expect(page.getByRole('status', { name: '表格保存结果', includeHidden: true })).toBeEmpty()
      await expect(page.getByRole('button', { name: '保存 CSV', exact: true })).toBeEnabled()
    }
})

test('a local React render failure shows escaped source and resets on revision without remounting its neighbor', async () => {
  const bundled = await bundleFixture({
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    stdin: {
      resolveDir: resolve('.'),
      contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MarkdownErrorBoundary} from './src/renderer/src/components/MarkdownErrorBoundary';
    const root=createRoot(document.body.appendChild(document.createElement('div')));
    function Bad({fail}) { if(fail) throw new Error('synthetic render fault'); return <p>已恢复</p> }
    function Neighbor() { const [count,setCount]=React.useState(0); return <button onClick={()=>setCount(count+1)}>邻居 {count}</button> }
    window.renderBoundaryFixture=(source,fail)=>root.render(<><MarkdownErrorBoundary source={source}><Bad fail={fail}/></MarkdownErrorBoundary><Neighbor/></>);
    window.renderBoundaryFixture('first',false);
  `,
      loader: 'tsx'
    }
  })
  const waiting = app.waitForEvent('window')
  await app.evaluate(async ({ BrowserWindow }) => {
    const fixture = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    await fixture.loadURL('about:blank')
  })
  const fixture = await waiting
  await fixture.addScriptTag({ content: bundled.outputFiles[0].text })
  await fixture.getByRole('button', { name: '邻居 0' }).click()
  await fixture.evaluate(() => {
    ;(
      window as unknown as { renderBoundaryFixture: (source: string, fail: boolean) => void }
    ).renderBoundaryFixture('<script>never execute</script> & full source', true)
  })
  await expect(fixture.getByText('Markdown 显示失败，以下是完整原文。')).toBeVisible()
  await expect(fixture.locator('.markdown-plain-fallback')).toHaveText(
    '<script>never execute</script> & full source'
  )
  await expect(fixture.getByRole('button', { name: '邻居 1' })).toBeVisible()
  await fixture.evaluate(() => {
    ;(
      window as unknown as { renderBoundaryFixture: (source: string, fail: boolean) => void }
    ).renderBoundaryFixture('next revision', false)
  })
  await expect(fixture.getByText('已恢复', { exact: true })).toBeVisible()
  await expect(fixture.getByRole('button', { name: '邻居 1' })).toBeVisible()
  await fixture.close()
})
