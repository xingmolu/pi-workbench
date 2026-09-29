import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserState } from '../shared/contracts'
import type { TerminalEvent, TerminalMetadata } from '../shared/terminal'
import { RemoteBrowser, type RemoteBrowserSource } from './remote-browser'
import { BROWSER_STOPPED } from './browser-action-lease'
import { RemoteTerminals, type RemoteTerminalSource } from './remote-terminals'
import { createRemoteViewsBridge } from './remote-views-bridge'

afterEach(() => {
  vi.useRealTimers()
})

function browserSource(): RemoteBrowserSource & {
  frames: string[]
  shot: boolean
  inputs: unknown[]
  operations: unknown[]
  mobile: boolean
} {
  const state: BrowserState = {
    available: true,
    visible: true,
    pages: [
      {
        id: 'p1',
        title: 'Dev',
        url: 'http://localhost:5173/',
        active: true,
        loading: false,
        canGoBack: true,
        canGoForward: false
      }
    ],
    activePageId: 'p1',
    controller: 'idle'
  }
  const source = {
    frames: ['a', 'a', 'b'],
    shot: true,
    inputs: [] as unknown[],
    operations: [] as unknown[],
    mobile: false,
    get remoteMobile() {
      return source.mobile
    },
    getState: () => state,
    captureActive: async () => {
      if (!source.shot) return null
      const bytes = Buffer.from(source.frames.shift() ?? 'b')
      const image = {
        getSize: () => ({ width: 800, height: 600 }),
        resize: () => image,
        toJPEG: () => bytes
      }
      return { image, width: 800, height: 600 }
    },
    remoteInput: (input: unknown) => {
      source.inputs.push(input)
    },
    setRemoteDevice: (mobile: boolean) => {
      source.mobile = mobile
    },
    executeUser: async (operation: unknown) => {
      source.operations.push(operation)
    }
  }
  return source
}

it('streams changed frames only while watched, reveals the panel and restores the page after', async () => {
  vi.useFakeTimers()
  const source = browserSource()
  const reveal = vi.fn()
  const remote = new RemoteBrowser(() => source, reveal, { idleMs: 100, activeMs: 50, burstMs: 0 })
  const events: [string, unknown][] = []
  const stop = remote.subscribe((event, data) => events.push([event, data]))
  expect(reveal).toHaveBeenCalledWith(false)
  expect(events[0]).toMatchObject(['state', { available: true, canGoBack: true, mobile: false }])
  await vi.advanceTimersByTimeAsync(400)
  const frames = events.filter(([event]) => event === 'frame').map(([, data]) => data)
  // "a" twice collapses into one frame, then "b"; repeats of "b" are not sent again.
  expect(
    frames.map((frame) => Buffer.from((frame as { data: string }).data, 'base64').toString())
  ).toEqual(['a', 'b'])
  expect(frames[0]).toMatchObject({ width: 800, height: 600 })

  source.shot = false
  await vi.advanceTimersByTimeAsync(200)
  expect(events.at(-1)).toMatchObject(['state', { message: expect.stringContaining('最小化') }])

  await remote.input({ type: 'device', mobile: true })
  expect(source.mobile).toBe(true)
  stop()
  expect(source.mobile).toBe(false)
  const count = events.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(events).toHaveLength(count)
})

it('opens a tab for a phone that navigates before the panel has one', async () => {
  const source = browserSource()
  source.getState().pages.length = 0
  await new RemoteBrowser(
    () => source,
    () => {}
  ).input({ type: 'navigate', url: 'localhost:5173' })
  expect(source.operations).toEqual([{ action: 'new_tab', url: 'localhost:5173' }])
})

it('retries a phone navigation once when the panel startup stopped it', async () => {
  const source = browserSource()
  let first = true
  source.executeUser = async (operation: unknown) => {
    source.operations.push(operation)
    if (first) {
      first = false
      throw new Error(BROWSER_STOPPED)
    }
  }
  await new RemoteBrowser(
    () => source,
    () => {}
  ).input({ type: 'navigate', url: 'localhost:1' })
  expect(source.operations).toHaveLength(2)
  source.executeUser = async () => {
    throw new Error('网址无效')
  }
  await expect(
    new RemoteBrowser(
      () => source,
      () => {}
    ).input({ type: 'navigate', url: 'x' })
  ).rejects.toThrow('网址无效')
})

it('maps phone input to page input, navigation and a wake request', async () => {
  const source = browserSource()
  const reveal = vi.fn()
  const remote = new RemoteBrowser(() => source, reveal)
  await remote.input({ type: 'tap', x: 10, y: 20 })
  await remote.input({ type: 'text', text: 'hi' })
  await remote.input({ type: 'navigate', url: 'localhost:5173' })
  await remote.input({ type: 'select_tab', pageId: 'p1' })
  await remote.input({ type: 'back' })
  await remote.input({ type: 'wake' })
  expect(source.inputs).toEqual([
    { type: 'tap', x: 10, y: 20 },
    { type: 'text', text: 'hi' }
  ])
  expect(source.operations).toEqual([
    { action: 'navigate', url: 'localhost:5173' },
    { action: 'select_tab', pageId: 'p1' },
    { action: 'back' }
  ])
  expect(reveal).toHaveBeenCalledWith(true)
})

function terminalSource(): {
  sent: string[]
  terminal: TerminalMetadata
  emit: (event: TerminalEvent) => void
  source: RemoteTerminalSource
} {
  let listener: (event: TerminalEvent) => void = () => {}
  const terminal: TerminalMetadata = {
    projectPath: '/p/app',
    terminalId: 't1',
    generation: 'g',
    connectionEpoch: 1,
    cols: 100,
    rows: 30,
    state: 'running',
    connection: 'consumer',
    exitConfirmed: false,
    exitCode: null,
    signal: null,
    failure: null
  }
  const sent: string[] = []
  return {
    sent,
    terminal,
    emit: (event: TerminalEvent) => listener(event),
    source: {
      observe: (next: (event: TerminalEvent) => void) => {
        listener = next
        return () => {
          listener = () => {}
        }
      },
      liveTerminals: () => [terminal],
      remoteInput: (_id: string, data: string) => {
        sent.push(data)
        return data !== 'refuse'
      }
    }
  }
}

it('replays recent terminal output to a late viewer, then streams and forwards keys', () => {
  const fixture = terminalSource()
  const remote = new RemoteTerminals(() => fixture.source)
  remote.attach()
  const output = (data: string, sequence: number): TerminalEvent => ({
    type: 'output',
    projectPath: '/p/app',
    terminalId: 't1',
    generation: 'g',
    connectionEpoch: 1,
    sequence,
    data
  })
  fixture.emit(output('$ npm run dev\r\n', 1))
  fixture.emit(output('ready on 5173\r\n', 2))
  expect(remote.list()).toEqual([
    { id: 'terminal:t1', kind: 'terminal', title: '终端 1', detail: 'app', live: true }
  ])
  const events: unknown[] = []
  const stop = remote.subscribe('t1', (event) => events.push(event))
  expect(events[0]).toEqual({
    type: 'replay',
    data: '$ npm run dev\r\nready on 5173\r\n',
    cols: 100,
    rows: 30,
    state: 'running'
  })
  fixture.emit(output('GET /\r\n', 3))
  expect(events[1]).toEqual({ type: 'output', data: 'GET /\r\n' })
  remote.input('t1', { type: 'key', key: 'Ctrl-C' })
  remote.input('t1', { type: 'text', data: 'ls\r' })
  expect(fixture.sent).toEqual(['\x03', 'ls\r'])
  expect(() => remote.input('t1', { type: 'text', data: 'refuse' })).toThrow('不能输入')
  stop?.()
  expect(remote.subscribe('missing', () => {})).toBeNull()
})

it('bounds the replay so a long-running terminal cannot grow memory', () => {
  const fixture = terminalSource()
  const remote = new RemoteTerminals(() => fixture.source)
  remote.attach()
  const chunk = 'x'.repeat(64 * 1024)
  for (let sequence = 1; sequence <= 10; sequence++)
    fixture.emit({
      type: 'output',
      projectPath: '/p/app',
      terminalId: 't1',
      generation: 'g',
      connectionEpoch: 1,
      sequence,
      data: chunk
    })
  let replay = ''
  remote.subscribe('t1', (event) => {
    if (event.type === 'replay') replay = event.data
  })
  expect(replay.length).toBe(256 * 1024)
})

it('validates input per view kind and hides views whose plugin is off', async () => {
  const source = browserSource()
  const fixture = terminalSource()
  const terminals = new RemoteTerminals(() => fixture.source)
  let browserOn = true
  const bridge = createRemoteViewsBridge({
    access: () => 'control',
    browser: () =>
      new RemoteBrowser(
        () => source,
        () => {}
      ),
    browserEnabled: () => browserOn,
    browserSummary: () => ({ live: true, detail: 'Dev' }),
    terminals,
    terminalEnabled: () => true
  })
  expect(bridge.list().map((view) => view.id)).toEqual(['browser', 'terminal:t1'])
  await expect(bridge.input('browser', { type: 'tap', x: -1, y: 0 })).rejects.toThrow('参数无效')
  await expect(bridge.input('terminal:t1', { type: 'key', key: 'Ctrl-X' })).rejects.toThrow(
    '参数无效'
  )
  await bridge.input('terminal:t1', { type: 'key', key: 'Enter' })
  expect(fixture.sent).toEqual(['\r'])
  browserOn = false
  expect(bridge.list().map((view) => view.id)).toEqual(['terminal:t1'])
  expect(bridge.subscribe('browser', () => {})).toBeNull()
  await expect(bridge.input('elsewhere', {})).rejects.toThrow('不存在')
})
