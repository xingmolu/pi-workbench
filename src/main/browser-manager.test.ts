import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const fixture = vi.hoisted(() => ({
  views: [] as any[],
  snapshot: undefined as undefined | (() => Promise<any>),
  locate: undefined as undefined | (() => Promise<any>),
  read: undefined as undefined | (() => Promise<any>)
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = 'about:blank'
    destroyed = false
    zoom = 1
    inputs: unknown[] = []
    navigationHistory = {
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: () => this.loadURL('https://example.org/back'),
      goForward: () => this.loadURL('https://example.org/forward')
    }
    async loadURL(url: string) {
      this.emit('did-start-navigation', {}, url, false, true, 1, 1)
      this.url = url
      this.emit('did-navigate', {}, url)
      this.emit('did-stop-loading')
    }
    reload() {
      void this.loadURL(this.url)
    }
    getURL() {
      return this.url
    }
    getTitle() {
      return 'Fixture'
    }
    getZoomFactor() {
      return this.zoom
    }
    isDestroyed() {
      return this.destroyed
    }
    isLoadingMainFrame() {
      return false
    }
    close() {
      this.destroyed = true
      this.emit('destroyed')
    }
    setWindowOpenHandler() {}
    async executeJavaScript(code: string) {
      if (code.includes('selectorFor'))
        return {
          title: 'Fixture',
          url: this.url,
          content: '',
          items: [{ selector: '#one', role: 'button', name: 'One', disabled: false }]
        }
      if (code.includes('getBoundingClientRect')) return { x: 20, y: 20 }
      return true
    }
    async executeJavaScriptInIsolatedWorld() {
      return fixture.read ? fixture.read() : true
    }
    sendInputEvent(event: unknown) {
      this.inputs.push(event)
    }
  }
  class View {
    webContents = new Contents()
    bounds = { x: 0, y: 0, width: 800, height: 600 }
    visible = true
    constructor() {
      fixture.views.push(this)
    }
    setBackgroundColor() {}
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds
    }
    getBounds() {
      return this.bounds
    }
    setVisible(visible: boolean) {
      this.visible = visible
    }
    getVisible() {
      return this.visible
    }
  }
  return {
    WebContentsView: View,
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
        on() {}
      })
    }
  }
})
vi.mock('./browser-targets', () => ({
  BrowserTargets: class {
    async snapshot() {
      if (fixture.snapshot) return fixture.snapshot()
      const nonce = randomUUID()
      const item = { token: nonce + ':1', role: 'button', name: 'One', href: '', type: '' }
      return {
        nonce,
        title: 'Fixture',
        content: '',
        items: [item],
        incomplete: false,
        text: JSON.stringify(item) + '\n'
      }
    }
    async invalidate() {}
    async dispose() {}
    async locate() {
      if (fixture.locate) return fixture.locate()
      return { x: 20, y: 20, width: 800, height: 600 }
    }
    async fill() {}
    async select() {}
  }
}))
import { BrowserManager, type BrowserAgentScope } from './browser-manager'

let manager: BrowserManager
let scope: BrowserAgentScope
beforeEach(async () => {
  fixture.views = []
  fixture.snapshot = undefined
  fixture.locate = undefined
  fixture.read = undefined
  manager = new BrowserManager(
    { contentView: { addChildView() {}, removeChildView() {} } } as unknown as BrowserWindow,
    () => {}
  )
  manager.setProject('/fixture')
  await manager.setView(true, { x: 10, y: 20, width: 800, height: 600 })
  scope = { owner: {}, projectPath: '/fixture', sessionId: 'session', generation: 1 }
})
afterEach(() => {
  manager.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function snapshotRef() {
  const result = await manager.executeUser({ action: 'snapshot' })
  if (result.kind !== 'snapshot') throw Error('snapshot expected')
  const match = result.text.match(/[0-9a-f-]{36}:1|@e1/)
  return { ref: match![0], result }
}

describe('Main browser page ownership', () => {
  it('scope invalidation revokes refs as well as prepared intents', async () => {
    const first = await snapshotRef()
    manager.prepare(scope, { action: 'tabs' })
    const pages = manager.getState().pages
    manager.invalidateAgentScope(scope.owner)
    expect(manager.getState().pages).toEqual(pages)
    expect(fixture.views[0].webContents.destroyed).toBe(false)
    expect(() => manager.prepare(scope, { action: 'click', ref: first.ref })).toThrow()
  })
  it('detects a view bounds change and reversal during locate', async () => {
    const first = await snapshotRef()
    fixture.locate = async () => {
      await manager.setView(true, { x: 10, y: 20, width: 400, height: 300 })
      await manager.setView(true, { x: 10, y: 20, width: 800, height: 600 })
      return { x: 20, y: 20, width: 800, height: 600 }
    }
    await expect(
      manager.executeAgent({ action: 'click', ref: first.ref }, 'bounds-aba')
    ).rejects.toThrow()
    expect(fixture.views[0].webContents.inputs).toHaveLength(0)
  })
  it('captures an operation copy and scope scalars, and ignores stale-owner invalidation', async () => {
    const operation = { action: 'keypress' as const, key: 'a' }
    const original = { ...scope }
    const ticket = manager.prepare(scope, operation)
    operation.key = 'b'
    scope.generation = 2
    manager.invalidateAgentScope({})
    await manager.executePrepared(original, ticket, 'fixed')
    expect(fixture.views[0].webContents.inputs[0]).toMatchObject({ keyCode: 'a' })
  })
  it('bounds prepared tickets, frees slots on release/expiry and rejects expired tickets by time', async () => {
    vi.useFakeTimers()
    const tickets = Array.from({ length: 8 }, () => manager.prepare(scope, { action: 'tabs' }))
    expect(() => manager.prepare(scope, { action: 'tabs' })).toThrow('上限')
    manager.releasePrepared(scope, tickets[0])
    manager.prepare(scope, { action: 'tabs' })
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300001)
    await expect(manager.executePrepared(scope, tickets[1], 'expired')).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(300001)
    expect(() => manager.prepare(scope, { action: 'tabs' })).not.toThrow()
  })
  it('stopped pending JavaScript returns promptly and cannot clear a new wait or publish its error', async () => {
    let rejectOld!: (error: Error) => void
    fixture.read = () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
    const old = manager.executeAgent({ action: 'wait', text: 'old' }, 'same').then(
      () => 'success',
      () => 'stopped'
    )
    manager.abortAgent('same')
    let settled = false
    void old.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(true)
    fixture.read = async () => false
    const next = manager
      .executeAgent({ action: 'wait', text: 'next' }, 'same')
      .catch(() => undefined)
    rejectOld(new Error('secret-page-error'))
    await old
    expect(manager.getState()).toMatchObject({ controller: 'agent', lastAction: '等待页面' })
    expect(manager.getState().error).toBeUndefined()
    manager.abortAgent()
    await next
  })
  it('does not register snapshot rows omitted by the Main whole-text budget', async () => {
    const nonce = randomUUID()
    const items = Array.from({ length: 160 }, (_, index) => ({
      token: nonce + ':' + (index + 1),
      role: 'link',
      name: 'n'.repeat(180),
      href: 'h'.repeat(1024),
      type: ''
    }))
    fixture.snapshot = async () => ({
      nonce,
      title: 't'.repeat(256),
      content: 'x'.repeat(6000),
      text: '',
      items,
      incomplete: false
    })
    const result = await manager.executeUser({ action: 'snapshot' })
    if (result.kind !== 'snapshot') throw Error('snapshot')
    expect(result.text.length).toBeLessThanOrEqual(20000)
    expect(result.text).toContain('[Snapshot incomplete]')
    const shown = items.filter((item) => result.text.includes(JSON.stringify(item) + '\n'))
    expect(shown.length).toBeLessThan(160)
    await expect(
      manager.executeAgent({ action: 'click', ref: items[shown.length].token }, 'omitted')
    ).rejects.toThrow()
  })
  it('rejects old zoom and changed bounds while locating instead of clamping input', async () => {
    const first = await snapshotRef()
    fixture.views[0].webContents.zoom = 1.25
    await expect(
      manager.executeAgent({ action: 'click', ref: first.ref }, 'zoom')
    ).rejects.toThrow()
    fixture.views[0].webContents.zoom = 1
    const next = await snapshotRef()
    fixture.locate = async () => {
      await manager.setView(true, { x: 10, y: 20, width: 400, height: 300 })
      return { x: 20, y: 20, width: 800, height: 600 }
    }
    await expect(
      manager.executeAgent({ action: 'click', ref: next.ref }, 'bounds')
    ).rejects.toThrow()
    expect(fixture.views[0].webContents.inputs).toHaveLength(0)
  })
  it('continuous snapshots cannot reuse an older slot token', async () => {
    const first = await snapshotRef()
    const second = await snapshotRef()
    expect(second.ref).not.toBe(first.ref)
    await expect(manager.executeAgent({ action: 'click', ref: first.ref }, 'old')).rejects.toThrow()
  })
  it('a token never resolves onto another page, with either omitted or incorrect pageId', async () => {
    const first = await snapshotRef()
    await manager.executeUser({ action: 'new_tab' })
    const second = await snapshotRef()
    expect(second.ref).not.toBe(first.ref)
    await expect(manager.executeAgent({ action: 'click', ref: first.ref }, 'old')).rejects.toThrow()
    await expect(
      manager.executeAgent(
        { action: 'click', ref: first.ref, pageId: second.result.pageId },
        'wrong'
      )
    ).rejects.toThrow()
  })
  it('navigation initiation immediately revokes old refs before commit', async () => {
    const first = await snapshotRef()
    fixture.views[0].webContents.emit(
      'did-start-navigation',
      {},
      'https://example.org/next',
      false,
      true,
      1,
      1
    )
    await expect(
      manager.executeAgent({ action: 'click', ref: first.ref }, 'navigation')
    ).rejects.toThrow()
  })
  it('prepare binds the original visible page and expires when the user changes tabs during Ask', async () => {
    expect(manager.prepare).toBeTypeOf('function')
    const first = await snapshotRef()
    const ticket = manager.prepare(scope, { action: 'click', ref: first.ref })
    expect(fixture.views[0].webContents.inputs).toHaveLength(0)
    await manager.executeUser({ action: 'new_tab' })
    await expect(manager.executePrepared(scope, ticket, 'approved')).rejects.toThrow()
    expect(fixture.views.every((view) => view.webContents.inputs.length === 0)).toBe(true)
  })
  it('prepared non-ref operations bind page/project/scope and cannot be replayed', async () => {
    expect(manager.prepare).toBeTypeOf('function')
    const ticket = manager.prepare(scope, { action: 'keypress', key: 'a' })
    await expect(
      manager.executePrepared({ ...scope, owner: {} }, ticket, 'foreign')
    ).rejects.toThrow()
    await manager.executePrepared(scope, ticket, 'first')
    await expect(manager.executePrepared(scope, ticket, 'replay')).rejects.toThrow()
  })
  it('snapshot pending at navigation is discarded instead of registering late refs', async () => {
    let resolve!: (value: any) => void
    fixture.snapshot = () =>
      new Promise((done) => {
        resolve = done
      })
    const pending = manager.executeAgent({ action: 'snapshot' }, 'pending')
    // The old implementation does not use the adapter; establish that missing boundary first.
    expect(resolve).toBeTypeOf('function')
    fixture.views[0].webContents.emit(
      'did-start-navigation',
      {},
      'https://example.org/next',
      false,
      true,
      1,
      1
    )
    const nonce = randomUUID()
    resolve({ nonce, title: '', content: '', text: '', items: [], incomplete: false })
    await expect(pending).rejects.toThrow()
  })
})
