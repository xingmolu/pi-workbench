import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalController,
  displayTitle,
  findFileLinks,
  inputChunks,
  pastePreview,
  pasteSafety,
  terminalKey
} from './terminal-controller'
import type { TerminalEvent, TerminalMetadata, TerminalResult } from '../../../shared/terminal'

const metadata = (projectPath = '/project'): TerminalMetadata => ({
  projectPath,
  terminalId: 'id',
  generation: 'generation',
  connectionEpoch: 2,
  cols: 80,
  rows: 24,
  state: 'degraded',
  connection: 'management',
  exitConfirmed: false,
  exitCode: null,
  signal: null,
  failure: null
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('terminal input policy', () => {
  it('bounds whole UTF-8 paste at 1 MiB and asks only when a paste could run or escape', () => {
    expect(pasteSafety('中文')).toBe('safe')
    expect(pasteSafety('x'.repeat(1024 * 1024))).toBe('safe')
    expect(pasteSafety('x'.repeat(1024 * 1024 + 1))).toBe('oversized')
    expect(pasteSafety('中'.repeat(349526))).toBe('oversized')
    expect(pasteSafety('tab\tseparated')).toBe('safe')
    // Newlines run commands only when the shell has not asked for bracketed paste.
    for (const text of ['a\nb', '\r', 'line\r\n'])
      expect([pasteSafety(text), pasteSafety(text, true)]).toEqual(['confirm', 'safe'])
    // Escapes, NUL, DEL and C1 controls can end a bracketed paste, so they always ask.
    for (const text of ['\x1b[201~rm', '\0', '\x7f', '\x85'])
      expect(pasteSafety(text, true)).toBe('confirm')
    expect(pasteSafety('')).toBe('empty')
  })
  it('splits input into accepted pieces without breaking a character', () => {
    expect(inputChunks('abcdef', 'utf8', 4)).toEqual(['abcd', 'ef'])
    expect(inputChunks('中中中', 'utf8', 7)).toEqual(['中中', '中'])
    expect(inputChunks('😀😀', 'utf8', 5)).toEqual(['😀', '😀'])
    expect(inputChunks('\xff\xfe\xfd', 'binary', 2)).toEqual(['\xff\xfe', '\xfd'])
    expect(inputChunks('', 'utf8')).toEqual([])
  })
  it('renders dangerous controls visibly and limits untrusted titles without changing identity', () => {
    expect(pastePreview('echo\r\x1b\n')).toBe('echo⟨U+000D⟩⟨U+001B⟩\n')
    expect(displayTitle('\x1b\u202e' + '中'.repeat(80))).toBe('中'.repeat(64))
    expect(terminalKey(metadata())).not.toBe(terminalKey({ ...metadata(), connectionEpoch: 3 }))
  })
})
function harness(command: (value: unknown) => Promise<TerminalResult>): {
  controller: TerminalController
  event: (event: TerminalEvent) => void
} {
  let receive: (event: TerminalEvent) => void = () => {}
  vi.stubGlobal('window', {
    pi: {
      terminal: command,
      onTerminalEvent: (listener: typeof receive) => {
        receive = listener
        return () => {}
      }
    }
  })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const controller = new TerminalController({} as HTMLDivElement, () => {})
  return { controller, event: (event) => receive(event) }
}
describe('file links in terminal output', () => {
  const links = (line: string) =>
    findFileLinks(line, '/work/shop').map(({ start, end, path, line: at }) => ({
      text: line.slice(start, end),
      path,
      line: at
    }))
  it('finds project files with a path or a line number, relative or absolute', () => {
    expect(links('src/cart.ts:12:5 - error TS2322')).toEqual([
      { text: 'src/cart.ts:12:5', path: 'src/cart.ts', line: 12 }
    ])
    expect(links('  at total (/work/shop/src/cart.ts:4)')).toEqual([
      { text: '/work/shop/src/cart.ts:4', path: 'src/cart.ts', line: 4 }
    ])
    expect(links('see ./docs/readme.md and package.json:3')).toEqual([
      { text: './docs/readme.md', path: 'docs/readme.md', line: undefined },
      { text: 'package.json:3', path: 'package.json', line: 3 }
    ])
  })
  it('leaves words, versions, other folders and parent paths alone', () => {
    expect(links('node v20.1.0 installed readme.md e.g. done')).toEqual([])
    expect(links('/etc/hosts.conf ../secret/key.pem src/../../x.ts')).toEqual([])
    expect(links('https://example.com/a/b.html')).toEqual([])
  })
})
describe('terminal input delivery', () => {
  const identity = {
    projectPath: '/project',
    terminalId: 'id',
    generation: 'generation',
    connectionEpoch: 2
  }
  type Send = (identity: object, data: string, encoding: 'utf8' | 'binary') => void
  it('keeps order and paces a large paste under the per-second input budget', async () => {
    vi.useFakeTimers()
    const inputs: { data: string; at: number }[] = []
    const { controller } = harness(async (value) => {
      const command = value as { type: string; data?: string }
      if (command.type === 'input') inputs.push({ data: command.data!, at: Date.now() })
      return { type: 'ok' }
    })
    const send = (controller as unknown as { sendInput: Send }).sendInput.bind(controller)
    send(identity, 'x'.repeat(100 * 1024), 'utf8')
    send(identity, 'y', 'utf8')
    await vi.advanceTimersByTimeAsync(0)
    // 56 KiB fits in the first second; the rest waits for the next window, typing after it.
    expect(inputs.map(({ data }) => data.length)).toEqual([16384, 16384, 16384])
    await vi.advanceTimersByTimeAsync(1100)
    expect(inputs.map(({ data }) => data.length)).toEqual([
      16384, 16384, 16384, 16384, 16384, 16384, 4096, 1
    ])
    expect(inputs.at(-1)!.data).toBe('y')
    expect(
      inputs
        .slice(0, 6)
        .map(({ data }) => data)
        .join('') + inputs[6].data
    ).toBe('x'.repeat(100 * 1024))
    controller.dispose()
  })
  it('drops the rest of a paste with the reason when Main refuses a piece', async () => {
    const inputs: string[] = []
    const { controller } = harness(async (value) => {
      const command = value as { type: string; data?: string }
      if (command.type !== 'input') return { type: 'ok' }
      inputs.push(command.data!)
      return inputs.length === 1 ? { type: 'unavailable', message: '终端已关闭' } : { type: 'ok' }
    })
    const send = (controller as unknown as { sendInput: Send }).sendInput.bind(controller)
    send(identity, 'x'.repeat(40 * 1024), 'utf8')
    await vi.waitFor(() => expect(controller.error).toBe('终端已关闭'))
    send(identity, 'next', 'utf8')
    await vi.waitFor(() => expect(inputs.at(-1)).toBe('next'))
    controller.dispose()
  })
})
describe('closing an idle terminal', () => {
  it('closes without asking when the shell is known to be idle, and asks otherwise', async () => {
    const running = {
      ...metadata(),
      state: 'running' as const,
      connection: 'consumer' as const,
      busy: false
    }
    const commands: string[] = []
    const { controller } = harness(async (value) => {
      const command = value as { type: string }
      commands.push(command.type)
      if (command.type === 'list') return { type: 'list', terminals: [running] }
      return { type: 'terminal', terminal: { ...running, state: 'closing' } }
    })
    await controller.context('/project', true)
    controller.requestClose()
    expect(controller.prompt).toBeNull()
    await vi.waitFor(() => expect(commands).toContain('close'))
    controller.dispose()

    const busy = harness(async (value) =>
      (value as { type: string }).type === 'list'
        ? { type: 'list', terminals: [{ ...running, busy: true }] }
        : { type: 'ok' }
    )
    await busy.controller.context('/project', true)
    busy.controller.requestClose()
    expect(busy.controller.prompt?.kind).toBe('close')
    busy.controller.dispose()
  })
})
describe('terminal management lifecycle', () => {
  it.each(['first', 'second', 'revisit', 'unrelated'])(
    'successful %s close dismissal clears a previously pending close on retry',
    async (successAt) => {
      vi.useFakeTimers()
      const exited = { ...metadata(), state: 'exited' as const, exitConfirmed: true }
      let closes = 0
      const command = vi.fn(async (value: unknown): Promise<TerminalResult> => {
        if ((value as { type: string }).type === 'list')
          return {
            type: 'list',
            terminals:
              (value as { projectPath: string }).projectPath === '/project'
                ? [closes >= 2 ? exited : metadata()]
                : []
          }
        closes++
        if (closes === 1) return { type: 'terminal', terminal: { ...metadata(), state: 'closing' } }
        if (closes === 2) return { type: 'unavailable', message: 'retry' }
        if (closes === 3 && successAt === 'second') return { type: 'terminal', terminal: exited }
        return { type: 'ok' }
      })
      const { controller, event } = harness(command)
      await controller.context('/project', true)
      controller.requestClose()
      const pending = controller.confirm()
      await vi.advanceTimersByTimeAsync(100)
      event({ type: 'state', terminal: exited })
      await vi.advanceTimersByTimeAsync(100)
      await pending
      expect(controller.current?.pendingDismiss).toBe(true)
      if (successAt === 'unrelated') controller.error = '另一操作的新错误'
      if (successAt === 'revisit') {
        await controller.context('/other', true)
        await controller.context('/project', true)
      } else {
        controller.requestClose()
        await controller.confirm()
      }
      expect(controller.entries).toEqual([])
      expect(controller.error).toBe(successAt === 'unrelated' ? '另一操作的新错误' : '')
      controller.dispose()
    }
  )
  it('pruning bounded management history preserves a valid selection in the affected project', async () => {
    const a = ['a1', 'a2', 'a3'].map((terminalId) => ({
      ...metadata('/a'),
      terminalId,
      exitConfirmed: true
    }))
    const b = Array.from({ length: 30 }, (_, i) => ({
      ...metadata('/b'),
      terminalId: `b${i}`,
      exitConfirmed: true
    }))
    let reads = 0
    const { controller } = harness(async () => ({
      type: 'list',
      terminals: ++reads === 1 ? a : reads === 2 ? b : a.slice(1)
    }))
    await controller.context('/a', true)
    await controller.context('/b', true)
    expect(controller.entries).toHaveLength(32)
    await controller.context('/a', true)
    expect(controller.current?.metadata.terminalId).toBe('a2')
    controller.dispose()
  })
  it('closing A preserves a newer selection of C instead of selecting B', async () => {
    vi.useFakeTimers()
    const terminals = ['a', 'b', 'c'].map((terminalId) => ({ ...metadata(), terminalId }))
    const command = vi.fn(async (value: unknown): Promise<TerminalResult> => {
      if ((value as { type: string }).type === 'list') return { type: 'list', terminals }
      if (command.mock.calls.length === 2)
        return { type: 'terminal', terminal: { ...terminals[0], state: 'closing' } }
      return { type: 'ok' }
    })
    const { controller, event } = harness(command)
    await controller.context('/project', true)
    controller.requestClose()
    const pending = controller.confirm()
    await vi.advanceTimersByTimeAsync(100)
    controller.select(controller.entries[2])
    event({ type: 'state', terminal: { ...terminals[0], state: 'exited', exitConfirmed: true } })
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(controller.current?.metadata.terminalId).toBe('c')
    controller.dispose()
  })
  it('background completed closes retain at most eight owned records and finish on project revisit', async () => {
    vi.useFakeTimers()
    const records = new Map<string, TerminalMetadata>()
    const command = vi.fn(async (value: unknown): Promise<TerminalResult> => {
      const command = value as { type: string; projectPath: string }
      if (command.type === 'list')
        return {
          type: 'list',
          terminals: [
            records.get(command.projectPath) ?? {
              ...metadata(command.projectPath),
              terminalId: command.projectPath
            }
          ]
        }
      if (!records.has(command.projectPath))
        return {
          type: 'terminal',
          terminal: {
            ...metadata(command.projectPath),
            terminalId: command.projectPath,
            state: 'closing'
          }
        }
      return { type: 'ok' }
    })
    const { controller, event } = harness(command)
    for (let i = 0; i < 8; i++) {
      const project = `/project-${i}`
      await controller.context(project, true)
      controller.requestClose()
      const pending = controller.confirm()
      await vi.advanceTimersByTimeAsync(100)
      await controller.context('/elsewhere', true)
      const exited = {
        ...metadata(project),
        terminalId: project,
        state: 'exited' as const,
        exitConfirmed: true
      }
      records.set(project, exited)
      event({ type: 'state', terminal: exited })
      await vi.advanceTimersByTimeAsync(100)
      await pending
    }
    expect(controller.retainedCount).toBe(8)
    await controller.context('/project-9', true)
    const before = command.mock.calls.length
    controller.requestClose()
    await controller.confirm()
    expect(command.mock.calls.length).toBe(before)
    expect(controller.error).toContain('8 个保留终端')
    await controller.context('/project-0', true)
    expect(controller.retainedCount).toBe(7)
    expect(controller.error).toContain('8 个保留终端')
    expect(controller.entries.some((entry) => entry.metadata.projectPath === '/project-0')).toBe(
      false
    )
    controller.dispose()
  })
  it('a late close reply cannot replace a newer confirmed exit event', async () => {
    let reply: (result: TerminalResult) => void = () => {}
    const command = vi.fn(async (value: unknown): Promise<TerminalResult> => {
      if ((value as { type: string }).type === 'list')
        return { type: 'list', terminals: [metadata()] }
      if (command.mock.calls.length === 2)
        return new Promise((resolve) => {
          reply = resolve
        })
      return { type: 'ok' }
    })
    const { controller, event } = harness(command)
    await controller.context('/project', true)
    controller.requestClose()
    const pending = controller.confirm()
    event({
      type: 'state',
      terminal: { ...metadata(), state: 'exited', exitConfirmed: true, exitCode: 0 }
    })
    reply({ type: 'terminal', terminal: { ...metadata(), state: 'closing' } })
    await pending
    expect(controller.entries).toEqual([])
    expect(controller.error).toBe('')
    controller.dispose()
  })
  it('ignores a stale project list across A to B to A and never spawns on list or selection', async () => {
    const replies: ((result: TerminalResult) => void)[] = []
    const command = vi.fn(() => new Promise<TerminalResult>((resolve) => replies.push(resolve)))
    const { controller } = harness(command)
    const first = controller.context('/a', true)
    const second = controller.context('/b', true)
    const third = controller.context('/a', true)
    replies[2]({ type: 'list', terminals: [{ ...metadata('/a'), terminalId: 'latest' }] })
    await third
    replies[0]({ type: 'list', terminals: [{ ...metadata('/a'), terminalId: 'stale' }] })
    await first
    replies[1]({ type: 'list', terminals: [metadata('/b')] })
    await second
    expect(controller.entries.map((e) => e.metadata.terminalId)).toEqual(['latest'])
    expect(command.mock.calls).toEqual([
      [{ type: 'list', projectPath: '/a' }],
      [{ type: 'list', projectPath: '/b' }],
      [{ type: 'list', projectPath: '/a' }]
    ])
    controller.dispose()
  })
  it('canceling degraded termination sends no close and context changes invalidate pending confirmation', async () => {
    const command = vi.fn(async (): Promise<TerminalResult> => ({
      type: 'list',
      terminals: [metadata()]
    }))
    const { controller } = harness(command)
    await controller.context('/project', true)
    controller.requestClose(true)
    controller.cancel()
    await controller.confirm()
    controller.requestClose(true)
    await controller.context('/project', false)
    await controller.confirm()
    expect(command).toHaveBeenCalledTimes(1)
    expect(controller.prompt).toBeNull()
    controller.dispose()
  })
  it('does not create a replacement if actual shell exit was never confirmed', async () => {
    vi.useFakeTimers()
    const command = vi.fn(async (value: unknown): Promise<TerminalResult> =>
      (value as { type: string }).type === 'list'
        ? { type: 'list', terminals: [metadata()] }
        : { type: 'terminal', terminal: { ...metadata(), state: 'closing' } }
    )
    const { controller } = harness(command)
    await controller.context('/project', true)
    controller.requestClose(true)
    const pending = controller.confirm()
    await vi.advanceTimersByTimeAsync(7000)
    await pending
    expect(controller.error).toContain('尚未确认 shell 退出')
    expect(command).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
  it('switching away and back while termination is in flight cancels replacement even after confirmed exit', async () => {
    vi.useFakeTimers()
    const command = vi.fn(async (value: unknown): Promise<TerminalResult> =>
      (value as { type: string }).type === 'list'
        ? { type: 'list', terminals: [metadata()] }
        : { type: 'terminal', terminal: { ...metadata(), state: 'closing' } }
    )
    const { controller, event } = harness(command)
    await controller.context('/project', true)
    controller.requestClose(true)
    const pending = controller.confirm()
    await vi.advanceTimersByTimeAsync(100)
    await controller.context('/project', false)
    await controller.context('/project', true)
    event({
      type: 'state',
      terminal: { ...metadata(), state: 'exited', exitConfirmed: true, exitCode: 0 }
    })
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(
      command.mock.calls.some(([value]) => (value as { type: string }).type === 'create')
    ).toBe(false)
    controller.dispose()
  })
})
