import { openWorkbenchTool } from './workbench-helpers'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication
let page: Page
let root: string
let project: string
const input = () => page.locator('.terminal-session:not([hidden]) .xterm-helper-textarea')
const screen = () => page.locator('.terminal-session:not([hidden]) .xterm-rows')
async function paste(text: string): Promise<void> {
  await input().evaluate((element, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
  }, text)
}
async function command(text: string): Promise<void> {
  await paste(text)
  await input().press('Enter')
}
async function create(): Promise<void> {
  await page.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeEnabled()
}
async function expectToolbarInsideWindow(): Promise<void> {
  for (const name of ['新建终端', '粘贴到终端', '关闭终端']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox()
    const width = await page.evaluate(() => innerWidth)
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  }
  expect(
    await page
      .locator('.terminal-pane')
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true)
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-terminal-ui-')))
  project = join(root, 'project')
  for (const dir of ['home', 'agent', 'data', 'project', 'other']) await mkdir(join(root, dir))
  app = await electron.launch({
    args: [resolve('.')],
    cwd: project,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  page = await app.firstWindow()
  await page.evaluate(() => {
    document.body.dataset.terminalOutput = ''
    window.pi.onTerminalEvent((event) => {
      if (event.type === 'output')
        document.body.dataset.terminalOutput = (
          document.body.dataset.terminalOutput + event.data
        ).slice(-131072)
    })
  })
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await openWorkbenchTool(page, '终端')
})
test.afterEach(async () => {
  if (app?.process().exitCode === null) await app.close()
  if (root) await rm(root, { recursive: true, force: true })
})
test('theme changes recolor the existing emulator without replacing its shell or buffer', async () => {
  await create()
  await command("printf 'THEME_BUFFER_%s\\n' $$")
  await expect(screen()).toContainText(/THEME_BUFFER_\d+/)
  const text = await screen().innerText()
  const pidMarker = text.match(/THEME_BUFFER_\d+/)![0]
  const terminalId = await page.locator('.terminal-session:not([hidden])').getAttribute('data-terminal-id')
  const darkColor = await screen().evaluate(el => getComputedStyle(el).color)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByLabel('主题', { exact: true }).selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(screen()).toContainText(pidMarker)
  await expect(page.locator('.terminal-session:not([hidden])')).toHaveAttribute('data-terminal-id', terminalId!)
  await expect.poll(() => screen().evaluate(el => getComputedStyle(el).color)).not.toBe(darkColor)
  expect(await page.locator('.terminal-session:not([hidden]) .xterm').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(243, 243, 242)')
  expect(await page.locator('.terminal-session:not([hidden]) .xterm-viewport').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(243, 243, 242)')
  await command("printf 'SAME_SHELL_%s\\n' $$")
  await expect(screen()).toContainText(pidMarker.replace('THEME_BUFFER', 'SAME_SHELL'))
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await page.screenshot({ path: 'artifacts/e2e/theme-light-terminal.png' })
})
test('explicit new opens two independent terminal tabs and preserves a shell through hide/show', async () => {
  await expect(page.getByText('尚未创建终端')).toBeVisible()
  await create()
  await expect(page.getByRole('tab', { name: /终端 1/ })).toBeVisible()
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeEnabled()
  await command("printf '%s_%s\\n' '中文' $$")
  await expect(page.locator('.terminal-session:not([hidden]) .xterm-rows')).toContainText(
    /中文_\d+/
  )
  const firstId = await page
    .locator('.terminal-session:not([hidden])')
    .getAttribute('data-terminal-id')
  const pid = (await screen().innerText()).match(/中文_(\d+)/)![1]
  await create()
  await expect(page.locator('.terminal-pane').getByRole('tab')).toHaveCount(2)
  await command("printf '%s_%s\\n' 'SECOND' $$")
  await expect(screen()).toContainText(/SECOND_\d+/)
  expect((await screen().innerText()).match(/SECOND_(\d+)/)![1]).not.toBe(pid)
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()
  await openWorkbenchTool(page, '终端')
  await expect(page.locator('.terminal-pane').getByRole('tab')).toHaveCount(2)
  await page.locator('.terminal-pane').getByRole('tab').first().click()
  expect(
    await page.locator('.terminal-session:not([hidden])').getAttribute('data-terminal-id')
  ).toBe(firstId)
  await command("printf '%s_%s\\n' 'AGAIN' $$")
  await expect(screen()).toContainText(`AGAIN_${pid}`)
  await mkdir(resolve('artifacts/e2e'), { recursive: true })
  await expectToolbarInsideWindow()
  await page.screenshot({ path: 'artifacts/e2e/terminal.png' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 760))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960)
  await expect
    .poll(async () => {
      const listed = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      const activeId = await page
        .locator('.terminal-session:not([hidden])')
        .getAttribute('data-terminal-id')
      const metadata =
        listed.type === 'list' ? listed.terminals.find((t) => t.terminalId === activeId) : undefined
      const rows = await page.locator('.terminal-session:not([hidden]) .xterm-rows > div').count()
      const fitted = await page.locator('.terminal-session:not([hidden])').evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const screen = element.querySelector('.xterm-screen')!.getBoundingClientRect()
        return screen.right <= bounds.right && screen.bottom <= bounds.bottom
      })
      return fitted && metadata && metadata.rows === rows && metadata.cols < 60
    })
    .toBe(true)
  const listedSize = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  const expectedSize =
    listedSize.type === 'list' && listedSize.terminals.find((t) => t.terminalId === firstId)
  await command("printf '%s:' 'SIZE'; stty size")
  await expect(screen()).toContainText(
    `SIZE:${expectedSize && expectedSize.rows} ${expectedSize && expectedSize.cols}`
  )
  await expectToolbarInsideWindow()
  await page.screenshot({ path: 'artifacts/e2e/terminal-960.png' })
})

test('project switching keeps input ownership, Ctrl-C interrupts, exit allows explicit replacement and double close is safe', async () => {
  await create()
  await command("printf '%s_%s\\n' 'A' $$")
  await expect(screen()).toContainText(/A_\d+/)
  const original = (await screen().innerText()).match(/A_(\d+)/)![1]
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'other'))
  await expect(page.getByText('尚未创建终端')).toBeVisible()
  await create()
  await command("printf '%s_%s\\n' 'B' $$")
  await expect(screen()).toContainText(/B_\d+/)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect(screen()).toContainText(`A_${original}`)
  await expect(screen()).not.toContainText(/B_\d+/)
  // Wait for the foreground process, not merely the echoed command. Otherwise
  // Ctrl-C can precede job startup and the next command is sent into sleep.
  await command(`sh -c 'printf "%s%s\\n" SLEEP_ READY; exec sleep 30'`)
  await expect(screen()).toContainText('SLEEP_READY')
  await input().press('Control+c')
  await expect(screen()).toContainText(/SLEEP_READY.*%/s)
  await command("printf '%s%s\\n' 'INTERRUPT_' 'OK'")
  await expect(screen()).toContainText('INTERRUPT_OK')
  await command('exit 7')
  await expect(page.getByText('Shell 已退出（退出码 7）')).toBeVisible()
  await page.getByRole('button', { name: '新建替代终端' }).click()
  await page.getByRole('button', { name: '确认结束并新建' }).click()
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  await page.getByRole('button', { name: '关闭终端', exact: true }).click()
  await page.getByRole('button', { name: '确认结束', exact: true }).dblclick()
  await expect(page.getByText('尚未创建终端')).toBeVisible()
})

test('dangerous paste is previewed before any bytes, canceled on context changes, and oversized input is rejected', async () => {
  await create()
  await paste("printf 'DANGER\\n'\r")
  await expect(page.getByRole('dialog', { name: '确认粘贴' })).toBeVisible()
  await expect(screen()).not.toContainText('DANGER')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await command("printf '%s%s\\n' 'CANCEL_' 'OK'")
  await expect(screen()).toContainText('CANCEL_OK')
  await expect(screen()).not.toContainText('DANGER')
  await paste('x'.repeat(8193))
  await expect(page.getByRole('alert')).toContainText('超过 8 KiB')
  await paste("printf '%s%s\\n' 'PASTE_' 'OK'\r")
  await page.getByRole('button', { name: '确认粘贴', exact: true }).click()
  await input().press('Enter')
  await expect(screen()).toContainText('PASTE_OK')
  await paste('never\n')
  await openWorkbenchTool(page, '文件')
  await openWorkbenchTool(page, '终端')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(screen()).not.toContainText('never')
})

test('confirmation contains Tab and Shift-Tab and restores terminal or management trigger focus', async () => {
  await page.addInitScript(() => {
    const original = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      if (this.getAttribute('aria-label') === '新建终端') {
        const observations = JSON.parse(document.body.dataset.focusProbe ?? '[]') as boolean[]
        observations.push((this as HTMLButtonElement).disabled)
        document.body.dataset.focusProbe = JSON.stringify(observations.slice(-10))
      }
      original.call(this, options)
    }
  })
  await create()
  await paste('not_sent\n')
  const cancel = page.getByRole('button', { name: '取消', exact: true })
  const confirm = page.getByRole('button', { name: '确认粘贴', exact: true })
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(input()).toBeFocused()
  await paste('echo ready\n')
  await page.getByRole('button', { name: '确认粘贴', exact: true }).click()
  await expect(input()).toBeFocused()
  await input().press('Control+c')
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await openWorkbenchTool(page, '终端')
  const trigger = page.getByRole('button', { name: '结束并新建', exact: true })
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('button', { name: '确认结束并新建' }).click()
  await expect(input()).toBeFocused()
  await page.getByRole('button', { name: '关闭终端', exact: true }).click()
  await page.getByRole('button', { name: '确认结束', exact: true }).click()
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeFocused()
  expect(await page.evaluate(() => JSON.parse(document.body.dataset.focusProbe ?? '[]'))).toEqual([
    false
  ])
})

test('background parser answers DSR and DA exactly once to its original PTY after a captured mouse drag', async () => {
  await create()
  await create()
  await page.locator('.terminal-pane').getByRole('tab').first().click()
  await command(
    `perl -MIO::Select -e '$|=1; system("stty -echo raw"); print "\\e[?1002h\\e[?1006hMOUSE_"."READY"; for(1..500){last if -e "${join(root, 'query-ready')}"; select undef,undef,undef,0.01} print "\\e[H\\e[6n\\e[c"; my $s=IO::Select->new(*STDIN); my $r=""; while($s->can_read(1)){sysread(STDIN,my $b,4096);$r.=$b} print "\\e[?1002l\\e[?1006l"; system("stty sane"); print "\\r\\nREPLY=".unpack("H*",$r)."\\r\\n";'`
  )
  await expect(screen()).toContainText('MOUSE_READY')
  const bounds = await page.locator('.terminal-session:not([hidden]) .xterm-screen').boundingBox()
  await page.mouse.move(bounds!.x + 35, bounds!.y + 35)
  await page.mouse.down()
  await page
    .locator('.terminal-pane')
    .getByRole('tab')
    .nth(1)
    .evaluate((element: HTMLElement) => element.click())
  await page.mouse.move(bounds!.x + 80, bounds!.y + 80)
  await page.mouse.up()
  await writeFile(join(root, 'query-ready'), '')
  await input().pressSequentially("printf '%s%s\\n' 'ONLY_' 'B'")
  await input().press('Enter')
  await expect(screen()).toContainText('ONLY_B')
  await page.locator('.terminal-pane').getByRole('tab').first().click()
  await expect(screen()).toContainText(/REPLY=[0-9a-f]+/)
  const raw = (await page.locator('body').getAttribute('data-terminal-output'))!
  const hex = raw.match(/REPLY=([0-9a-f]+)[\r\n]/)![1]
  expect(Buffer.from(hex, 'hex').toString()).toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[1;1R\x1b\[\?1;2c$/)
  await expect(screen()).not.toContainText('ONLY_B')
})

test('hidden real parser consumes a MiB burst without truncation and leaves both shells responsive', async () => {
  await create()
  const terminalId = await page
    .locator('.terminal-session:not([hidden])')
    .getAttribute('data-terminal-id')
  await page.evaluate((id) => {
    let remainder = ''
    let rows = 0
    let bytes = 0
    document.body.dataset.stressRows = '0'
    window.pi.onTerminalEvent((event) => {
      if (event.type !== 'output' || event.terminalId !== id) return
      bytes += new TextEncoder().encode(event.data).length
      const lines = (remainder + event.data).split('\n')
      remainder = lines.pop()!.slice(-1024)
      rows += lines.filter((line) => /^S{127}\r?$/.test(line)).length
      document.body.dataset.stressRows = String(rows)
      document.body.dataset.stressBytes = String(bytes)
    })
  }, terminalId)
  await command(
    `perl -e 'for(1..1000){last if -e "${join(root, 'stress-ready')}"; select undef,undef,undef,0.01} exit 2 unless -e "${join(root, 'stress-ready')}"; print "S"x127,"\\n" for 1..8192; print "STRESS_"."DONE\\n";'`
  )
  await create()
  await expect(page.locator(`[data-terminal-id="${terminalId}"]`)).toHaveAttribute('hidden', '')
  await expect(page.locator('body')).toHaveAttribute('data-stress-rows', '0')
  await writeFile(join(root, 'stress-ready'), '')
  await command("printf '%s%s\\n' 'ACTIVE_' 'RESPONSIVE'")
  await expect(screen()).toContainText('ACTIVE_RESPONSIVE')
  await expect(page.locator('body')).toHaveAttribute('data-stress-rows', '8192', { timeout: 15000 })
  expect(
    Number(await page.locator('body').getAttribute('data-stress-bytes'))
  ).toBeGreaterThanOrEqual(1048576)
  await page.locator('.terminal-pane').getByRole('tab').first().click()
  await expect(screen()).toContainText('STRESS_DONE')
  await command("printf '%s%s\\n' 'AFTER_' 'RESPONSIVE'")
  await expect(screen()).toContainText('AFTER_RESPONSIVE')
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  await expect(page.getByRole('alert')).toHaveCount(0)
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: '关闭终端', exact: true }).click()
    await page.getByRole('button', { name: '确认结束', exact: true }).click()
    await expect(page.locator('.terminal-pane').getByRole('tab')).toHaveCount(1 - i)
  }
  const listed = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  expect(listed.type === 'list' && listed.terminals.length).toBe(0)
})

test('untrusted OSC titles are bounded display text and OSC52 or OSC8 cannot access clipboard or open windows', async () => {
  await create()
  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { terminalExternalCalls?: number }
    state.terminalExternalCalls = 0
    shell.openExternal = async () => {
      state.terminalExternalCalls!++
    }
  })
  await page.evaluate(() => {
    document.body.dataset.clipboardCalls = '0'
    const called = (): void => {
      document.body.dataset.clipboardCalls = String(
        Number(document.body.dataset.clipboardCalls) + 1
      )
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          called()
        },
        readText: async () => {
          called()
          return ''
        }
      }
    })
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await command(
    `printf '\\033]2;<img src=x onerror=alert(1)>EVIL\\007\\033]52;c;c2VjcmV0\\007\\033]8;;file:///tmp/evil\\007LINK\\033]8;;\\007\\n'; printf '%s%s\\n' 'OSC_' 'DONE'`
  )
  await expect(page.locator('.terminal-pane').getByRole('tab')).toContainText('<img src=x onerror=alert(1)>EVIL')
  await expect(screen()).toContainText('OSC_DONE')
  expect(await page.locator('.terminal-pane img').count()).toBe(0)
  expect(errors).toEqual([])
  expect(await page.locator('body').getAttribute('data-clipboard-calls')).toBe('0')
  expect(app.windows()).toHaveLength(1)
  await page
    .locator('.terminal-session:not([hidden]) .xterm-rows')
    .getByText('LINK', { exact: false })
    .first()
    .click({ force: true })
  expect(
    await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { terminalExternalCalls?: number }).terminalExternalCalls
    )
  ).toBe(0)
})

test('legacy binary mouse input is blocked during paste confirmation while parser replies continue', async () => {
  await create()
  await command(
    `perl -MIO::Select -e '$|=1; system("stty -echo raw"); print "\\e[?1002hLEGACY_"."READY"; for(1..500){last if -e "${join(root, 'binary-ready')}"; select undef,undef,undef,0.01} print "\\e[H\\e[6n\\e[c"; my $s=IO::Select->new(*STDIN); my $r=""; while($s->can_read(1)){sysread(STDIN,my $b,4096);$r.=$b} print "\\e[?1002l"; system("stty sane"); print "\\r\\nBINARY=".unpack("H*",$r)."\\r\\n";'`
  )
  await expect(screen()).toContainText('LEGACY_READY')
  const bounds = await page.locator('.terminal-session:not([hidden]) .xterm-screen').boundingBox()
  await page.mouse.move(bounds!.x + 35, bounds!.y + 35)
  await page.mouse.down()
  await paste('DO_NOT_SEND\n')
  await expect(page.getByRole('dialog', { name: '确认粘贴' })).toBeVisible()
  await page.mouse.move(bounds!.x + 80, bounds!.y + 80)
  await page.mouse.up()
  await writeFile(join(root, 'binary-ready'), '')
  await expect
    .poll(() => page.locator('body').getAttribute('data-terminal-output'))
    .toMatch(/BINARY=[0-9a-f]+[\r\n]/)
  const raw = (await page.locator('body').getAttribute('data-terminal-output'))!
  const hex = raw.match(/BINARY=([0-9a-f]+)[\r\n]/)![1]
  expect(Buffer.from(hex, 'hex').toString('latin1')).toMatch(
    /^\x1b\[M [\x21-\xff]{2}\x1b\[1;1R\x1b\[\?1;2c$/
  )
  await page.getByRole('button', { name: '取消', exact: true }).click()
})

test('synthetic Chinese IME and terminal keys stay byte-exact and Enter does not reach global handlers', async () => {
  await create()
  await command(
    `perl -MIO::Select -e '$|=1; system("stty -echo raw"); print "KEYS_"."READY"; my $s=IO::Select->new(*STDIN); my $r=""; while($s->can_read(2)){sysread(STDIN,my $b,4096);$r.=$b} system("stty sane"); print "\\r\\nKEYS=".unpack("H*",$r)."\\r\\n";'`
  )
  await expect(screen()).toContainText('KEYS_READY')
  await input().evaluate(async (element: HTMLTextAreaElement) => {
    element.value = ''
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.value = '中文'
    element.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: '中文' })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.body.dataset.globalEnters = '0'
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Enter')
        document.body.dataset.globalEnters = String(Number(document.body.dataset.globalEnters) + 1)
    })
  })
  await input().press('Tab')
  await input().press('ArrowUp')
  await input().press('Alt+x')
  await input().press('Control+c')
  await input().press('Enter')
  await expect(screen()).toContainText(/KEYS=[0-9a-f]+/)
  const hex = (await screen().innerText()).match(/KEYS=([0-9a-f]+)/)![1]
  expect(Buffer.from(hex, 'hex').toString()).toBe('中文\t\x1b[A\x1bx\x03\r')
  expect(await page.locator('body').getAttribute('data-global-enters')).toBe('0')
})

test('switching tabs cancels pending IME composition without sending it to either terminal', async () => {
  await create()
  await create()
  await page.locator('.terminal-pane').getByRole('tab').first().click()
  await input().evaluate((element: HTMLTextAreaElement) => {
    element.value = ''
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.value = '绝不发送'
    element.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: '绝不发送' })
    )
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '绝不发送' })
    )
    document.querySelectorAll<HTMLButtonElement>('.terminal-tabs button')[1].click()
  })
  await command("printf '%s%s\\n' 'B_' 'CLEAN'")
  await expect(screen()).toContainText('B_CLEAN')
  await expect(screen()).not.toContainText('绝不发送')
  await page.locator('.terminal-pane').getByRole('tab').first().click()
  await command("printf '%s%s\\n' 'A_' 'CLEAN'")
  await expect(screen()).toContainText('A_CLEAN')
  await expect(screen()).not.toContainText('绝不发送')
})

test('an exited terminal retains selectable, copyable and scrollable output', async () => {
  await create()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copiedTerminal = text
        }
      }
    })
  })
  await command(
    `for n in $(seq 1 100); do printf 'LINE_%s\\n' "$n"; done; printf '%s%s\\n' COPY_ READY; exit`
  )
  await expect(page.getByText('Shell 已退出（退出码 0）')).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator('.terminal-session:not([hidden])')
        .evaluate(
          (element) =>
            element.querySelector('.xterm-screen')!.getBoundingClientRect().bottom <=
            element.getBoundingClientRect().bottom
        )
    )
    .toBe(true)
  const copyLine = screen().getByText('COPY_READY', { exact: true })
  await expect(copyLine).toBeVisible()
  // xterm receives pointer input on its screen, not the rendered text spans.
  // Use that real target so Playwright waits for layout instead of forcing a stale span.
  const terminalScreen = page.locator('.terminal-session:not([hidden]) .xterm-screen')
  const lineBounds = (await copyLine.boundingBox())!
  const screenBounds = (await terminalScreen.boundingBox())!
  await terminalScreen.dblclick({
    position: {
      x: lineBounds.x - screenBounds.x + lineBounds.width / 2,
      y: lineBounds.y - screenBounds.y + lineBounds.height / 2
    }
  })
  await page.keyboard.press('Meta+c')
  await expect(page.locator('body')).toHaveAttribute('data-copied-terminal', 'COPY_READY')
  const viewport = page.locator('.terminal-session:not([hidden]) .xterm-screen')
  const before = await screen().innerText()
  const box = await viewport.boundingBox()
  await page.mouse.move(box!.x + 30, box!.y + 30)
  await page.mouse.wheel(0, -350)
  await expect.poll(() => screen().innerText()).not.toBe(before)
})

test('renderer reload exposes management-only degraded state and requires confirmed termination before new shell', async () => {
  await create()
  await command("printf '%s_%s\\n' 'RELOAD' $$")
  await expect(screen()).toContainText(/RELOAD_\d+/)
  const before = await page.evaluate(
    async (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await openWorkbenchTool(page, '终端')
  await expect(page.getByText('终端进程仍在，屏幕状态未恢复')).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)
  await expectToolbarInsideWindow()
  await page.screenshot({ path: 'artifacts/e2e/terminal-reload.png' })
  await page.getByRole('button', { name: '结束并新建', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(
    await page.evaluate(async (projectPath) => {
      const r = await window.pi.terminal({ type: 'list', projectPath })
      return r.type === 'list' && r.terminals.length
    }, project)
  ).toBe(1)
  await page.getByRole('button', { name: '结束并新建', exact: true }).click()
  await page.getByRole('button', { name: '确认结束并新建' }).click()
  await expect(page.locator('.terminal-status')).toContainText('运行中')
  const after = await page.evaluate(
    async (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  expect(
    before.type === 'list' &&
      after.type === 'list' &&
      before.terminals[0].terminalId !== after.terminals[0].terminalId
  ).toBe(true)
})
