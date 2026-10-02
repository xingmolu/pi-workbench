import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { displayEnv } from './display-env'
import { build } from 'esbuild'

let app: ElectronApplication, page: Page, root: string
async function launch(extraEnv: Record<string, string> = {}) {
  const xauthority = process.env.XAUTHORITY || join(homedir(), '.Xauthority')
  app = await electron.launch({
    args: [resolve('.')],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
      ...(xauthority ? { XAUTHORITY: xauthority } : {}),
      ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
      ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
      ...displayEnv(),
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data'),
      PI_CODING_AGENT_DIR: join(root, 'agent'),
      ...extraEnv
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-settings-e2e-')))
  for (const name of ['home', 'agent', 'user-data'])
    await mkdir(join(root, name), { recursive: true })
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('appearance theme persists, follows system changes, and updates highlighted preview', async () => {
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  const initialTheme = await page.evaluate(() =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  await expect(page.locator('html')).toHaveAttribute('data-theme', initialTheme)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  const themeCard = (name: string) =>
    page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name, exact: true })
  await expect(themeCard('跟随系统')).toHaveAttribute('aria-checked', 'true')
  const preview = page.locator('.sp-preview .highlighted-code')
  await expect(preview).toHaveAttribute('data-highlighted', 'true')
  await themeCard('深色').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const darkColor = await preview.locator('span[style]').first().evaluate(el => getComputedStyle(el).color)
  await themeCard('浅色').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(preview).toHaveAttribute('data-highlighted', 'true')
  await expect.poll(() => preview.locator('span[style]').first().evaluate(el => getComputedStyle(el).color)).not.toBe(darkColor)
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await page.screenshot({ path: 'artifacts/e2e/theme-light-settings.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await themeCard('跟随系统').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect((await page.evaluate(() => window.pi.desktopSettings({ type: 'get' }))).theme).toBe('system')
  await themeCard('浅色').click()
  await expect(themeCard('跟随系统')).toBeEnabled()
  await app.close()
  await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  for (const section of ['手机', '引擎与账号', 'MCP 服务器', 'Skills 技能', 'Desktop 插件', '桌面控制']) {
    await page.getByRole('button', { name: section, exact: true }).click()
    expect(await page.locator('.settings-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await themeCard('跟随系统').click()
  await expect(themeCard('跟随系统')).toBeEnabled()
  await app.close()
  await launch()
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  // Playwright can emulate the renderer color scheme independently of nativeTheme.
  const expected = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', expected)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(themeCard('跟随系统')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-theme', expected)
})

test('trusted IPC persists across restart, resets only preferences, and shows grouped settings at both widths', async ({}, testInfo) => {
  const defaults = await page.evaluate(() => window.pi.desktopSettings({ type: 'get' }))
  expect(defaults.messageFontSize).toBe(15)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settingsSearch = page.getByRole('searchbox', { name: '搜索设置', exact: true })
  await expect(settingsSearch).toBeVisible()
  await settingsSearch.fill('MCP')
  await expect(page.getByRole('button', { name: 'MCP 服务器', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '外观', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '清空设置搜索', exact: true }).click()
  await expect(page.getByRole('button', { name: '引擎与账号', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await expect(page.getByText('基础设置', { exact: true })).toBeVisible()
  await expect(page.getByText('Agent 能力', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByLabel('消息字号').selectOption('18')
  await expect(page.getByLabel('消息字号')).toBeEnabled()
  await page.getByLabel('代码字号').selectOption('16')
  await expect(page.getByLabel('代码字号')).toBeEnabled()
  await page.getByRole('switch', { name: '代码默认换行' }).click()
  await expect(page.getByRole('switch', { name: '代码默认换行' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  for (const section of ['外观', '常规']) {
    await page.getByRole('button', { name: section, exact: true }).click()
    for (const width of [960, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${section}-${width}.png`) })
    }
  }
  await page.getByLabel('发送快捷键').selectOption('modifier-enter')
  await expect(page.getByLabel('发送快捷键')).toBeEnabled()
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(page.getByLabel('发送快捷键')).toHaveValue(defaults.sendShortcut)
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await expect(page.getByLabel('消息字号')).toHaveValue('18')
  await page.getByRole('button', { name: '常规', exact: true }).click()
  await page.getByLabel('发送快捷键').selectOption('modifier-enter')
  await app.close()
  await launch()
  expect(await page.evaluate(() => window.pi.desktopSettings({ type: 'get' }))).toEqual({
    ...defaults,
    messageFontSize: 18,
    codeFontSize: 16,
    codeWrap: true,
    sendShortcut: 'modifier-enter'
  })
  const saved = JSON.parse(
    await readFile(join(root, 'user-data/pi-desktop-preferences.json'), 'utf8')
  )
  expect(saved.desktopSettings.messageFontSize).toBe(18)
  expect(await page.evaluate(() => window.pi.desktopSettings({ type: 'reset' }))).toEqual(defaults)
  const reset = JSON.parse(
    await readFile(join(root, 'user-data/pi-desktop-preferences.json'), 'utf8')
  )
  expect(reset.desktopSettings).toBeUndefined()
  delete saved.desktopSettings
  expect(reset).toEqual(saved)
})

test('actual conversation fonts, wrap override, copy, work attention and keyboard behavior', async () => {
  const windowReady = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    void win.loadURL('about:blank')
  })
  const harness = await windowReady
  harness.on('pageerror', (error) => console.error('Harness error:', error.message))
  const bundle = await build({
    stdin: {
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Conversation from ${JSON.stringify(resolve('src/renderer/src/components/Conversation.tsx'))};
    import {EMPTY_SNAPSHOT,usePiStore} from ${JSON.stringify(resolve('src/renderer/src/store/pi-store.ts'))};
    import {useDesktopSettings} from ${JSON.stringify(resolve('src/renderer/src/store/desktop-settings.ts'))};
    const initial={...EMPTY_SNAPSHOT,metrics:{...EMPTY_SNAPSHOT.metrics,turns:1,input:100,output:20},ready:true,sessionId:'a',generation:1,project:{path:'/fixture',name:'Fixture'},modelAvailability:'available',composeBlockReason:null,activeProvider:'fixture',activeModel:'offline',models:[{provider:'fixture',id:'offline',name:'offline',contextWindow:1000,reasoning:false}],accounts:[],nodes:[{id:'user',type:'user',text:'用户正文'},{id:'tool',type:'tool',title:'Read',name:'read',intent:'read',status:'success',input:'',output:'tool result'},{id:'assistant',type:'assistant',markdown:${JSON.stringify('正文\n\n' + '\x60\x60\x60js\nconst long = "' + 'x'.repeat(180) + '";\n\x60\x60\x60')}}]};
    window.sent=0;window.copied=''; Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copied=value}}});
    window.pi={send:async()=>({kind:'skills-list',catalog:{sessionId:'a',generation:1,skills:[],total:0,truncated:false}})};
    usePiStore.setState({snapshot:initial});
    function settings(patch){const settings={...useDesktopSettings.getState().settings,...patch};useDesktopSettings.setState({settings,status:'ready',hasLoaded:true});document.documentElement.style.setProperty('--message-font-size',settings.messageFontSize+'px');document.documentElement.style.setProperty('--code-font-size',settings.codeFontSize+'px');document.documentElement.dataset.reducedMotion=String(settings.reducedMotion)}
    window.harness={settings,stream(status='done',busy=true){usePiStore.setState({snapshot:{...initial,busy,nodes:initial.nodes.map(n=>n.type==='tool'?{...n,status}:n.type==='assistant'?{...n,streaming:busy,markdown:n.markdown+'\\nstream update'}:n)}})}};
    const noop=()=>{}; function Harness(){const snapshot=usePiStore(state=>state.snapshot);return <Conversation snapshot={snapshot} approvals={[]} loading={false} onSend={async()=>{window.sent++;return true}} onChooseProject={noop} onOpenSession={noop} onReconnect={noop} reconnecting={false} onAbort={noop} onClearQueue={noop} onPermissionChange={noop} onChooseModel={noop} onLogin={noop} onOpenSettings={noop} onApproval={noop}/>}
    createRoot(document.getElementById('root')).render(<Harness/>);
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
  await harness.setContent('<div id="root"></div>')
  await harness.addStyleTag({
    content: await readFile(resolve('src/renderer/src/assets/main.css'), 'utf8')
  })
  await harness.addStyleTag({
    content: await readFile(resolve('src/renderer/src/assets/desktop-settings.css'), 'utf8')
  })
  await harness.addStyleTag({
    content: await readFile(resolve('src/renderer/src/assets/theme.css'), 'utf8')
  })
  await harness.addStyleTag({
    content: await readFile(resolve('src/renderer/src/assets/conversation-activity.css'), 'utf8')
  })
  await harness.addScriptTag({ content: bundle.outputFiles[0].text })
  const pendingInput = harness.getByRole('textbox', { name: '任务输入', exact: true })
  await pendingInput.fill('等待偏好')
  await pendingInput.press('Enter')
  await expect(pendingInput).toHaveValue('等待偏好\n')
  expect(await harness.evaluate(() => (window as any).sent)).toBe(0)
  await harness.evaluate(() =>
    (window as any).harness.settings({
      messageFontSize: 18,
      codeFontSize: 16,
      codeWrap: true,
      workDetails: 'expanded',
      showUsage: true
    })
  )
  await expect
    .poll(() =>
      harness
        .locator('.assistant-node > p')
        .first()
        .evaluate((e) => getComputedStyle(e).fontSize)
    )
    .toBe('18px')
  await expect
    .poll(() => harness.locator('.user-node').evaluate((e) => getComputedStyle(e).fontSize))
    .toBe('18px')
  await expect
    .poll(() => harness.locator('.code-block pre').evaluate((e) => getComputedStyle(e).fontSize))
    .toBe('16px')
  await expect
    .poll(() => harness.locator('.code-block pre').evaluate((e) => getComputedStyle(e).whiteSpace))
    .toBe('pre-wrap')
  await harness.getByRole('button', { name: '复制代码', exact: true }).click()
  expect(await harness.evaluate(() => (window as any).copied)).toBe(
    `const long = "${'x'.repeat(180)}";`
  )
  await harness.getByRole('button', { name: '自动换行', exact: true }).click()
  await harness.locator('.work-summary-trigger').click()
  await harness.evaluate(() => (window as any).harness.stream())
  await harness.emulateMedia({ reducedMotion: 'no-preference' })
  const activityAnimationSeconds = () => harness.locator('.conversation-activity .activity-orbit')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration))
  await expect.poll(activityAnimationSeconds).toBe(1)
  await harness.evaluate(() => (window as any).harness.settings({ reducedMotion: true }))
  await expect.poll(activityAnimationSeconds).toBeLessThan(0.001)
  await harness.evaluate(() => (window as any).harness.settings({ reducedMotion: false }))
  await expect.poll(activityAnimationSeconds).toBe(1)
  await harness.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(activityAnimationSeconds).toBeLessThan(0.001)
  await harness.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(harness.locator('.work-summary-content')).toBeHidden()
  await expect
    .poll(() => harness.locator('.code-block pre').evaluate((e) => getComputedStyle(e).whiteSpace))
    .toBe('pre')
  for (const status of ['awaiting-approval', 'error', 'blocked']) {
    await harness.evaluate((status) => (window as any).harness.stream(status), status)
    // Pending approval stays visible; acknowledged errors respect manual collapse.
    if (status === 'awaiting-approval') await expect(harness.locator('.work-summary-content')).toBeVisible()
    else await expect(harness.locator('.work-summary-content')).toBeHidden()
  }
  await harness.evaluate(() => (window as any).harness.stream('done', false))
  const input = harness.getByRole('textbox', { name: '任务输入', exact: true })
  await input.fill('first')
  await input.press('Enter')
  await expect.poll(() => harness.evaluate(() => (window as any).sent)).toBe(1)
  await expect(harness.locator('.composer-stats')).toBeVisible()
  await harness.evaluate(() =>
    (window as any).harness.settings({ sendShortcut: 'modifier-enter', showUsage: false })
  )
  await input.fill('line')
  await input.press('Enter')
  await expect(input).toHaveValue('line\n')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('line\n\n')
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, ctrlKey: true })
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, ctrlKey: true })
  expect(await harness.evaluate(() => (window as any).sent)).toBe(1)
  await input.press('Control+Enter')
  await expect.poll(() => harness.evaluate(() => (window as any).sent)).toBe(2)
  await input.fill('button still sends')
  await harness.getByRole('button', { name: '发送任务', exact: true }).click()
  await expect.poll(() => harness.evaluate(() => (window as any).sent)).toBe(3)
  await expect(harness.locator('.composer-stats')).toHaveCount(0)
  await expect(harness.locator('.context-meter')).toBeVisible()
})

/**
 * Windows only runs the CLI as an .exe, so the fake is a small C# program built with the
 * compiler that ships with Windows PowerShell; it answers like the shell script used elsewhere.
 */
async function fakeWindowsTailscale(binDir: string, serveState: string): Promise<void> {
  const state = JSON.stringify(serveState)
  const json = (value: unknown): string => JSON.stringify(JSON.stringify(value))
  const source = join(binDir, 'tailscale.cs')
  await writeFile(
    source,
    `using System; using System.IO;
class Tailscale {
  static int Main(string[] a) {
    string state = ${state};
    bool on = File.Exists(state) && File.ReadAllText(state) == "on";
    if (a.Length > 0 && a[0] == "status") Console.Write(${json({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail123.ts.net.', Online: true } })});
    else if (a.Length > 1 && a[0] == "serve" && a[1] == "status") Console.Write(on ? ${json({ URL: 'https://my-mac.tail123.ts.net' })} : "{}");
    else if (a.Length > 1 && a[0] == "serve" && a[1] == "--bg") File.WriteAllText(state, "on");
    else if (a.Length > 1 && a[0] == "serve" && a[1] == "off") File.WriteAllText(state, "off");
    return 0;
  }
}
`
  )
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${source}') -OutputAssembly '${join(binDir, 'tailscale.exe')}' -OutputType ConsoleApplication`
  ])
}

test('mobile Tailscale settings resolve a PATH CLI, enable Serve, and copy the URL', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '手机', exact: true }).click()
  await page.getByRole('button', { name: '检测', exact: true }).click()
  await expect(page.getByRole('button', { name: '开启 Tailscale Serve' })).toBeDisabled()
  await expect(page.getByRole('status')).toContainText('未找到 Tailscale CLI')

  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const serveState = join(root, 'tailscale-serve-state')
  if (process.platform === 'win32') await fakeWindowsTailscale(binDir, serveState)
  else {
    await writeFile(
      join(binDir, 'tailscale'),
      `#!/bin/sh
state=${JSON.stringify(serveState)}
on() { [ -f "$state" ] && [ "$(cat "$state")" = "on" ]; }
if [ "$1" = "status" ]; then
  printf '%s' '{"BackendState":"Running","Self":{"DNSName":"my-mac.tail123.ts.net.","Online":true}}'
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then
  if on; then printf '%s' '{"URL":"https://my-mac.tail123.ts.net"}'
  else printf '%s' '{}'
  fi
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "--bg" ]; then
  printf 'on' > "$state"
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "off" ]; then
  printf 'off' > "$state"
  exit 0
fi
exit 0
`
    )
    await chmod(join(binDir, 'tailscale'), 0o755)
  }
  await app.close()
  await launch({
    PATH: [
      binDir,
      ...(process.platform === 'win32' ? [process.env.PATH ?? ''] : ['/usr/bin', '/bin'])
    ].join(delimiter),
    TAILSCALE_SERVE_STATE: serveState
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '手机', exact: true }).click()
  await page.getByRole('button', { name: '检测', exact: true }).click()
  await expect(page.getByText('my-mac.tail123.ts.net')).toBeVisible()
  await expect(page.getByRole('button', { name: '开启 Tailscale Serve' })).toBeEnabled()
  await page.getByRole('button', { name: '开启 Tailscale Serve' }).click()
  await expect(page.getByText('https://my-mac.tail123.ts.net')).toBeVisible()
  await page.locator('.mobile-tailscale-status').getByRole('button', { name: '复制' }).click()
  await expect(page.locator('.mobile-tailscale-status').getByRole('button', { name: '已复制' })).toBeVisible()
  await page.getByRole('button', { name: '显示配对码', exact: true }).click()
  await expect(page.getByAltText('手机配对二维码')).toBeVisible()
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await page.screenshot({ path: 'artifacts/e2e/mobile-tailscale-serve.png' })
  await page.locator('.settings-content').screenshot({ path: 'artifacts/e2e/mobile-settings-panel.png' })
  await page.locator('.mobile-tailscale-status').scrollIntoViewIfNeeded()
  await page.locator('.mobile-gateway-settings .settings-card').last().screenshot({
    path: 'artifacts/e2e/mobile-settings-tailscale.png'
  })
})

test('desktop control settings exposes permission without requiring a TCC grant', async () => {
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  const permission = await page.evaluate(() => window.pi.desktopControl({ type: 'permission' }))
  expect(permission.type).toBe('permission')
  if (permission.type !== 'permission') throw new Error('expected permission')
  expect(['granted', 'denied', 'restricted', 'pending', 'unsupported']).toContain(
    permission.permission.access
  )
  const sources = await page.evaluate(() => window.pi.desktopControl({ type: 'sources' }))
  expect(sources.type).toBe('sources')
  if (sources.type === 'sources' && !sources.permission.canCapture) expect(sources.probed).toBe(false)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '桌面控制', exact: true }).click()
  await expect(page.getByRole('heading', { name: '桌面控制' })).toBeVisible()
  await expect(page.getByRole('button', { name: '手机', exact: true })).toBeVisible()
  await expect(page.getByTestId('screen-recording-status')).toHaveText(
    new RegExp(`^(${['已授权', '未授权', '受限', '待确认', '不支持'].join('|')})$`)
  )
  await expect(page.getByTestId('accessibility-status')).toHaveText(
    new RegExp(`^(${['已授权', '未授权', '受限', '待确认', '不支持'].join('|')})$`)
  )
  await expect(page.getByText('Computer Use：屏幕捕获、辅助功能与确认后输入', { exact: true })).toBeVisible()
  await expect(page.getByText(/授权新安装包后，请完全退出/)).toBeVisible()
  const openSettings = page.getByRole('button', { name: '打开系统设置（屏幕录制）' })
  if (permission.permission.canOpenSettings) await expect(openSettings).toBeEnabled()
  else await expect(openSettings).toBeDisabled()
  const axPerm = await page.evaluate(() =>
    window.pi.desktopControl({ type: 'accessibility-permission' })
  )
  expect(axPerm.type).toBe('accessibility-permission')
  if (axPerm.type !== 'accessibility-permission') throw new Error('expected accessibility-permission')
  const openAccessibility = page.getByRole('button', { name: '打开系统设置（辅助功能）' })
  if (axPerm.permission.canOpenSettings) await expect(openAccessibility).toBeEnabled()
  else await expect(openAccessibility).toBeDisabled()
  await page.getByRole('button', { name: '重新检测权限' }).click()
  await expect(page.getByRole('button', { name: '重新检测权限' })).toBeEnabled()
  const ax = await page.evaluate(() => window.pi.desktopControl({ type: 'accessibility-dump' }))
  expect(ax.type).toBe('accessibility-dump')
  if (ax.type === 'accessibility-dump') {
    // The test process can inherit a different TCC identity from a normal app launch.
    const supported = process.platform === 'darwin'
    expect(ax.permission.platformSupported).toBe(supported)
    if (supported) expect(['granted', 'denied', 'pending']).toContain(ax.permission.access)
    else expect(ax.permission.access).toBe('unsupported')
    expect(ax.probed).toBe(supported)
    if (ax.permission.access !== 'granted') expect(ax.dump).toBeNull()
  }
  const preview = await page.evaluate(() =>
    window.pi.desktopControl({ type: 'input-preview', x: 12, y: 40 })
  )
  expect(preview.type).toBe('input-preview')
  if (preview.type === 'input-preview') {
    expect(preview.allowed).toBe(
      process.platform === 'darwin' &&
        preview.accessibility.access === 'granted' &&
        preview.sessionUnlocked
    )
  }
  await expect(
    page.evaluate(() => window.pi.desktopControl({ type: 'input-click', x: 12, y: 40 } as never))
  ).rejects.toBeTruthy()
  await page.getByRole('button', { name: '读取窗口结构' }).click()
  await expect(page.getByTestId('ax-dump')).toBeVisible()
  if (ax.type === 'accessibility-dump' && ax.permission.access === 'denied') {
    await expect(page.getByTestId('ax-dump')).toContainText('当前运行的 Pi Desktop')
  }
  await expect(page.getByRole('button', { name: '确认点击' })).toBeDisabled()
  await page.screenshot({ path: 'artifacts/e2e/desktop-control-settings.png' })
})

test('General settings shows the version and exports a redacted diagnostics report', async () => {
  const report = join(root, 'report.md')
  await app.close()
  await launch({ PI_DESKTOP_E2E_DIAGNOSTICS_PATH: report })
  // A warning with a secret in it lands in the main log, but not in the report.
  await app.evaluate(() => console.warn('fixture warning sk-ant-api03-SECRETSECRETSECRET'))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '常规', exact: true }).click()
  await expect(page.getByText('版本与更新', { exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: '更新状态' })).toContainText('开发版本不检查更新')
  await expect(page.getByRole('status', { name: '诊断状态' })).toContainText('没有进程意外退出')
  await page.getByRole('button', { name: '导出…' }).click()
  await expect(page.getByRole('status', { name: '诊断状态' })).toContainText('已保存到')
  const text = await readFile(report, 'utf8')
  expect(text).toContain('# Pi Desktop 诊断信息')
  expect(text).toContain('fixture warning sk-…')
  expect(text).not.toContain('SECRETSECRET')
  expect(text).toMatch(/- 引擎程序: \[".*claude: /)
})

test('a new user without accounts is offered ways to connect a model', async () => {
  const project = join(root, 'project')
  await mkdir(project)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  const connect = page.getByRole('region', { name: '连接模型' })
  await expect(connect).toBeVisible()
  await expect(connect.getByRole('button')).toHaveText([
    /ChatGPT 账号/,
    /API Key/,
    /Claude 账号.*首次需要下载引擎/
  ])
  await expect(page.locator('.composer-lock')).toContainText('先连接一个模型账号')
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await page.screenshot({ path: resolve('artifacts/e2e/home-connect.png') })
  // "API Key" lands on the add-API panel in Settings.
  await connect.getByRole('button', { name: /API Key/ }).click()
  await expect(page.getByRole('group', { name: '添加 API 连接' })).toBeVisible()
})
