import { randomUUID } from 'node:crypto'
import {
  session,
  type BrowserWindow,
  type NativeImage,
  type Rectangle,
  WebContentsView
} from 'electron'
import type { RemoteBrowserInput } from '../shared/remote-views'
import type {
  BrowserBounds,
  BrowserOperation,
  BrowserOperationResult,
  BrowserPageSummary,
  BrowserState
} from '../shared/contracts'
import { browserOperationSchema } from '../shared/schemas'
import { browserRefSchema } from '../shared/browser-ref'
import { pageContainsTextScript } from './browser-page-scripts'
import {
  browserPartitionForProject,
  isAllowedBrowserKey,
  normalizeBrowserUrl
} from './browser-security'
import { BrowserTargets } from './browser-targets'
import {
  BrowserActionLeases,
  awaitBrowserAction,
  type BrowserActionLease,
  BROWSER_STALE,
  BROWSER_STOPPED,
  BROWSER_UNKNOWN,
  waitForDelay
} from './browser-action-lease'

/** Main-only identity. The bridge supplies its captured utility-process owner, never wire input. */
export type BrowserAgentScope = {
  owner: object
  projectPath: string
  sessionId: string | null
  generation: number
}
type BrowserPage = {
  id: string
  view: WebContentsView
  targets: BrowserTargets
  title: string
  url: string
  loading: boolean
  revision: number
  refs: Map<string, { epoch: number; zoom: number }>
}
type Lease = BrowserActionLease<BrowserPage>
type Prepared = {
  scope: BrowserAgentScope
  operation: BrowserOperation
  page: BrowserPage | null
  documentEpoch: number
  projectEpoch: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}
type Navigation = {
  lease: Lease
  page: BrowserPage
  url: string
  started: boolean
  committed: boolean
}
const configuredBrowserPartitions = new Set<string>()
const sameScope = (a: BrowserAgentScope, b: BrowserAgentScope): boolean =>
  a.owner === b.owner &&
  a.projectPath === b.projectPath &&
  a.sessionId === b.sessionId &&
  a.generation === b.generation

export class BrowserManager {
  private readonly pages = new Map<string, BrowserPage>()
  private activePageId: string | null = null
  private projectPath: string | null = null
  private projectEpoch = 0
  private visible = false
  private bounds: BrowserBounds | null = null
  private layoutEpoch = 0
  private lastAction: string | undefined
  private lastError: string | undefined
  private readonly actions = new BrowserActionLeases<BrowserPage>()
  private readonly prepared = new Map<string, Prepared>()
  private agentScope: BrowserAgentScope | null = null
  private readonly compatibilityOwner = {}
  private navigation: Navigation | null = null
  private sendingSyntheticInput = false
  /** A paired phone asked for a phone-sized viewport. */
  private remoteDevice = false
  private readonly emulated = new WeakMap<WebContentsView, string>()
  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void
  ) {}
  getState(): BrowserState {
    return {
      available: Boolean(this.projectPath),
      visible: this.visible,
      pages: [...this.pages.values()].map((page) => this.pageSummary(page)),
      activePageId: this.activePageId,
      controller: this.actions.current?.kind ?? 'idle',
      ...(this.lastAction ? { lastAction: this.lastAction } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }
  /**
   * The active page's viewport for a remote viewer, or null when nothing is renderable: the
   * page must be shown in the window, because hidden views stop producing frames.
   */
  async captureActive(): Promise<{ image: NativeImage; width: number; height: number } | null> {
    const page = this.activePageId ? this.pages.get(this.activePageId) : undefined
    const size = this.viewport()
    if (!page || !size || page.view.webContents.isDestroyed()) return null
    const image = await page.view.webContents.capturePage({ x: 0, y: 0, ...size })
    return image.isEmpty() ? null : { image, ...size }
  }
  get remoteMobile(): boolean {
    return this.remoteDevice
  }
  /** Emulates a phone-sized page so the remote viewer sees the mobile layout. */
  setRemoteDevice(mobile: boolean): void {
    if (this.remoteDevice === mobile) return
    this.remoteDevice = mobile
    this.layoutViews()
    this.publish()
  }
  /**
   * Taps, scrolls and typing from the paired phone. They go through the same input path as a
   * person at the desktop, so they also take the page over from a running agent.
   */
  remoteInput(
    input: Extract<RemoteBrowserInput, { type: 'tap' | 'scroll' | 'text' | 'key' }>
  ): void {
    const page = this.activePageId ? this.pages.get(this.activePageId) : undefined
    const size = this.viewport()
    if (!page || !size || page.view.webContents.isDestroyed())
      throw new Error('浏览器当前没有可操作的页面')
    const contents = page.view.webContents
    const clamp = (value: number, max: number): number =>
      Math.max(0, Math.min(max - 1, Math.round(value)))
    switch (input.type) {
      case 'tap': {
        const x = clamp(input.x, size.width)
        const y = clamp(input.y, size.height)
        contents.focus()
        contents.sendInputEvent({ type: 'mouseMove', x, y })
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        break
      }
      case 'scroll':
        contents.sendInputEvent({
          type: 'mouseWheel',
          x: clamp(input.x, size.width),
          y: clamp(input.y, size.height),
          deltaX: -input.dx,
          deltaY: -input.dy
        })
        break
      case 'text':
        this.abortAgent()
        contents.focus()
        void contents.insertText(input.text)
        break
      case 'key':
        contents.focus()
        contents.sendInputEvent({ type: 'keyDown', keyCode: input.key })
        contents.sendInputEvent({ type: 'keyUp', keyCode: input.key })
        break
    }
    this.lastAction = '手机远程操作'
    this.publish()
  }
  private viewport(): { width: number; height: number } | null {
    const bounds = this.bounds
    if (!this.visible || !bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return this.remoteDevice
      ? { width: Math.min(390, bounds.width), height: Math.min(844, bounds.height) }
      : { width: bounds.width, height: bounds.height }
  }
  setProject(projectPath: string | null): void {
    if (this.projectPath === projectPath) return
    this.invalidateAgentScope()
    this.actions.cancel()
    this.projectEpoch++
    this.destroyAllPages()
    this.projectPath = projectPath
    this.lastError = this.lastAction = undefined
    this.publish()
  }
  async setView(visible: boolean, bounds?: BrowserBounds): Promise<void> {
    if (!visible && this.visible) this.abortAgent()
    this.visible = visible
    if (bounds) {
      if (JSON.stringify(bounds) !== JSON.stringify(this.bounds)) this.layoutEpoch++
      this.bounds = { ...bounds }
    }
    if (visible && this.projectPath && this.pages.size === 0)
      await this.executeUser({ action: 'new_tab' })
    this.layoutViews()
    this.publish()
  }
  /** Freezes validated intent without executing page code or sending input. */
  prepare(scope: BrowserAgentScope, operation: BrowserOperation): string {
    this.assertScope(scope)
    for (const [ticket, intent] of this.prepared)
      if (intent.expiresAt <= performance.now()) this.removePrepared(ticket)
    const parsed = browserOperationSchema.safeParse(operation)
    if (!parsed.success) throw new Error(BROWSER_STALE)
    const op = parsed.data
    if (op.action === 'navigate' || (op.action === 'new_tab' && op.url))
      normalizeBrowserUrl(op.url!)
    if (op.action === 'keypress' && !isAllowedBrowserKey(op.key))
      throw new Error('不允许发送这个按键')
    if (op.action === 'wait' && !op.text && !op.url) throw new Error('wait 需要 text 或 url')
    if ('value' in op && op.value.length > 10000) throw new Error(BROWSER_STALE)
    const page = this.operationPage(op)
    if (page) this.assertAgentPage(page, op)
    if (this.prepared.size >= 8) throw new Error('待确认的浏览器操作已达上限，请完成或取消后再试')
    const ticket = randomUUID(),
      timer = setTimeout(() => this.removePrepared(ticket), 5 * 60_000)
    timer.unref?.()
    this.prepared.set(ticket, {
      scope: { ...scope },
      operation: op,
      page,
      documentEpoch: page?.revision ?? 0,
      projectEpoch: this.projectEpoch,
      expiresAt: performance.now() + 5 * 60_000,
      timer
    })
    return ticket
  }
  async executePrepared(
    scope: BrowserAgentScope,
    ticket: string,
    requestId: string
  ): Promise<BrowserOperationResult> {
    this.assertScope(scope)
    const intent = this.prepared.get(ticket)
    if (!intent || !sameScope(intent.scope, scope)) throw new Error(BROWSER_STALE)
    this.removePrepared(ticket)
    if (
      intent.expiresAt <= performance.now() ||
      intent.projectEpoch !== this.projectEpoch ||
      (intent.page &&
        (this.pages.get(intent.page.id) !== intent.page ||
          intent.page.revision !== intent.documentEpoch))
    )
      throw new Error(BROWSER_STALE)
    if (intent.page) this.assertAgentPage(intent.page, intent.operation)
    if (this.actions.current) throw new Error('另一个浏览器操作仍在运行，请等待结束后重新读取页面')
    return this.execute(intent.operation, 'agent', requestId, intent.page)
  }
  releasePrepared(scope: BrowserAgentScope, ticket: string): void {
    const intent = this.prepared.get(ticket)
    if (intent && sameScope(intent.scope, scope)) this.removePrepared(ticket)
  }
  /** Owning Main bridge calls this on Host exit/restart and session/generation change. */
  invalidateAgentScope(owner?: object): void {
    if (owner && this.agentScope?.owner !== owner) return
    this.abortAgent()
    for (const page of this.pages.values()) this.revokeRefs(page)
    this.agentScope = null
  }
  async executeAgent(
    operation: BrowserOperation,
    requestId: string
  ): Promise<BrowserOperationResult> {
    const scope = {
      owner: this.compatibilityOwner,
      projectPath: this.projectPath ?? '',
      sessionId: null,
      generation: 0
    }
    return this.executePrepared(scope, this.prepare(scope, operation), requestId)
  }
  async executeUser(operation: BrowserOperation): Promise<BrowserOperationResult> {
    this.abortAgent()
    this.actions.cancel()
    return this.execute(operation, 'user', randomUUID(), this.operationPage(operation))
  }
  abortAgent(requestId?: string): void {
    const lease = this.actions.current
    if (requestId && (!lease || lease.kind !== 'agent' || lease.requestId !== requestId)) return
    this.clearPrepared()
    if (lease?.kind !== 'agent') return
    this.actions.cancel()
    if (this.navigation?.lease === lease) this.navigation = null
    this.lastAction = BROWSER_STOPPED
    this.publish()
  }
  dispose(): void {
    this.invalidateAgentScope()
    this.actions.cancel()
    this.projectEpoch++
    this.destroyAllPages()
    this.projectPath = null
  }
  private assertScope(scope: BrowserAgentScope): void {
    if (!this.projectPath || scope.projectPath !== this.projectPath) throw new Error(BROWSER_STALE)
    if (this.agentScope && !sameScope(this.agentScope, scope)) throw new Error(BROWSER_STALE)
    this.agentScope ??= { ...scope }
  }
  private removePrepared(ticket: string): void {
    const intent = this.prepared.get(ticket)
    if (intent) clearTimeout(intent.timer)
    this.prepared.delete(ticket)
  }
  private clearPrepared(): void {
    for (const ticket of this.prepared.keys()) this.removePrepared(ticket)
  }
  private operationPage(operation: BrowserOperation): BrowserPage | null {
    if (operation.action === 'tabs' || operation.action === 'new_tab') return null
    if ('ref' in operation) {
      if (!browserRefSchema.safeParse(operation.ref).success) throw new Error(BROWSER_STALE)
      const page = [...this.pages.values()].find((candidate) => candidate.refs.has(operation.ref))
      if (!page || (operation.pageId && operation.pageId !== page.id))
        throw new Error(BROWSER_STALE)
      this.requireRef(page, operation.ref)
      return page
    }
    return this.requirePage(operation.pageId ?? this.activePageId)
  }
  private assertAgentPage(page: BrowserPage, operation: BrowserOperation): void {
    if (this.pages.get(page.id) !== page || page.view.webContents.isDestroyed())
      throw new Error(BROWSER_STALE)
    if (operation.action === 'select_tab' || operation.action === 'close_tab') return
    this.visibleGeometry(page)
    if ('ref' in operation) this.requireRef(page, operation.ref)
  }
  private assertLease(lease: Lease): void {
    const page = lease.page
    this.actions.assert(lease, this.projectEpoch, page, page?.revision ?? 0)
    if (page && (this.pages.get(page.id) !== page || page.view.webContents.isDestroyed()))
      throw new Error(BROWSER_STALE)
  }
  private async execute(
    operation: BrowserOperation,
    kind: 'user' | 'agent',
    requestId: string,
    page: BrowserPage | null
  ): Promise<BrowserOperationResult> {
    if (!this.projectPath) throw new Error('请先选择工作区，再打开浏览器')
    const lease = this.actions.begin(kind, requestId, this.projectEpoch, page, page?.revision ?? 0)
    this.lastAction = this.actionLabel(operation)
    this.lastError = undefined
    this.publish()
    try {
      const result = await awaitBrowserAction(this.run(operation, lease), lease.controller.signal)
      this.assertLease(lease)
      return result
    } catch (error) {
      const owned = this.actions.current === lease && !lease.controller.signal.aborted
      const message = !owned
        ? BROWSER_STOPPED
        : error instanceof Error &&
            [
              BROWSER_STALE,
              BROWSER_STOPPED,
              '等待页面条件超时',
              '不允许发送这个按键',
              'wait 需要 text 或 url'
            ].includes(error.message)
          ? error.message
          : BROWSER_UNKNOWN
      if (owned) this.lastError = message
      throw new Error(message)
    } finally {
      if (this.navigation?.lease === lease) this.navigation = null
      if (this.actions.finish(lease)) this.publish()
    }
  }
  private async run(operation: BrowserOperation, lease: Lease): Promise<BrowserOperationResult> {
    this.assertLease(lease)
    switch (operation.action) {
      case 'tabs':
        return { kind: 'state', state: this.getState() }
      case 'new_tab': {
        const page = this.createPage(lease),
          url = operation.url ? normalizeBrowserUrl(operation.url) : 'about:blank'
        await this.navigate(page, lease, url, () => page.view.webContents.loadURL(url))
        return this.actionResult(page, '已新建标签页')
      }
      case 'select_tab': {
        const page = lease.page!
        this.setActivePage(page.id, lease)
        return this.actionResult(page, '已切换标签页')
      }
      case 'close_tab': {
        this.closePage(lease.page!, lease)
        let page = this.activePageId ? this.requirePage(this.activePageId) : null
        if (!page) {
          page = this.createPage(lease)
          await this.navigate(page, lease, 'about:blank', () =>
            page!.view.webContents.loadURL('about:blank')
          )
        } else {
          lease.page = page
          lease.documentEpoch = page.revision
        }
        return this.actionResult(page, '已关闭标签页')
      }
    }
    const page = lease.page!,
      contents = page.view.webContents
    switch (operation.action) {
      case 'navigate': {
        const url = normalizeBrowserUrl(operation.url)
        await this.navigate(page, lease, url, () => contents.loadURL(url))
        return this.actionResult(page, '页面已打开')
      }
      case 'reload':
        await this.navigate(page, lease, contents.getURL(), () => contents.reload())
        return this.actionResult(page, '页面已重新加载')
      case 'back':
      case 'forward': {
        const history = contents.navigationHistory
        if (operation.action === 'back' ? history.canGoBack() : history.canGoForward()) {
          const entry = history.getEntryAtIndex(
            history.getActiveIndex() + (operation.action === 'back' ? -1 : 1)
          )
          await this.navigate(page, lease, entry.url, () =>
            operation.action === 'back' ? history.goBack() : history.goForward()
          )
        }
        return this.actionResult(page, operation.action === 'back' ? '已后退' : '已前进')
      }
      case 'snapshot':
        return this.snapshot(page, lease)
      case 'screenshot': {
        const image = await contents.capturePage()
        this.assertLease(lease)
        return {
          kind: 'screenshot',
          pageId: page.id,
          url: contents.getURL().slice(0, 4096),
          mimeType: 'image/png',
          data: image.toPNG().toString('base64')
        }
      }
      case 'click': {
        this.requireRef(page, operation.ref)
        const before = this.visibleGeometry(page),
          point = await page.targets.locate(operation.ref)
        this.assertLease(lease)
        const after = this.visibleGeometry(page)
        this.requireRef(page, operation.ref)
        if (
          JSON.stringify(before) !== JSON.stringify(after) ||
          Math.abs(point.width * after.zoom - after.bounds.width) > after.zoom ||
          Math.abs(point.height * after.zoom - after.bounds.height) > after.zoom
        )
          throw new Error(BROWSER_STALE)
        const x = Math.round(point.x * after.zoom),
          y = Math.round(point.y * after.zoom)
        if (
          !Number.isSafeInteger(x) ||
          !Number.isSafeInteger(y) ||
          x < 0 ||
          y < 0 ||
          x >= after.bounds.width ||
          y >= after.bounds.height
        )
          throw new Error(BROWSER_STALE)
        this.synthetic(lease, () =>
          contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        )
        this.synthetic(lease, () =>
          contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        )
        this.revokeRefs(page)
        return this.actionResult(page, '已派发点击，请读取页面确认结果')
      }
      case 'fill':
      case 'select':
        this.requireRef(page, operation.ref)
        await page.targets[operation.action](operation.ref, operation.value)
        this.assertLease(lease)
        this.revokeRefs(page)
        return this.actionResult(page, operation.action === 'fill' ? '已填写页面' : '已选择选项')
      case 'keypress':
        if (!isAllowedBrowserKey(operation.key)) throw new Error('不允许发送这个按键')
        this.synthetic(lease, () =>
          contents.sendInputEvent({ type: 'keyDown', keyCode: operation.key })
        )
        if (operation.key.length === 1)
          this.synthetic(lease, () =>
            contents.sendInputEvent({ type: 'char', keyCode: operation.key })
          )
        this.synthetic(lease, () =>
          contents.sendInputEvent({ type: 'keyUp', keyCode: operation.key })
        )
        this.revokeRefs(page)
        return this.actionResult(page, '已派发按键，请读取页面确认结果')
      case 'scroll': {
        const amount = Math.min(4000, operation.amount ?? 720),
          axis = operation.direction === 'left' || operation.direction === 'right' ? 'left' : 'top'
        const signed =
          operation.direction === 'up' || operation.direction === 'left' ? -amount : amount
        await contents.executeJavaScriptInIsolatedWorld(1087, [
          { code: `window.scrollBy({ ${axis}: ${signed}, behavior: 'instant' }); true` }
        ])
        this.assertLease(lease)
        this.revokeRefs(page)
        return this.actionResult(page, '已滚动页面')
      }
      case 'wait': {
        if (!operation.text && !operation.url) throw new Error('wait 需要 text 或 url')
        const deadline = Date.now() + Math.min(30000, operation.timeoutMs ?? 10000)
        while (Date.now() < deadline) {
          this.assertLease(lease)
          const urlMatches = !operation.url || contents.getURL().includes(operation.url)
          const textMatches =
            !operation.text ||
            (await contents.executeJavaScriptInIsolatedWorld(1087, [
              { code: pageContainsTextScript(operation.text) }
            ]))
          this.assertLease(lease)
          if (urlMatches && textMatches === true) return this.actionResult(page, '等待条件已满足')
          await waitForDelay(120, lease.controller.signal)
          this.assertLease(lease)
        }
        throw new Error('等待页面条件超时')
      }
    }
  }
  private synthetic(lease: Lease, send: () => void): void {
    this.assertLease(lease)
    if (lease.kind === 'agent') this.visibleGeometry(lease.page!)
    this.sendingSyntheticInput = true
    try {
      send()
    } finally {
      this.sendingSyntheticInput = false
    }
    this.assertLease(lease)
  }
  private visibleGeometry(page: BrowserPage): {
    bounds: Rectangle
    zoom: number
    layoutEpoch: number
  } {
    const bounds = page.view.getBounds(),
      zoom = page.view.webContents.getZoomFactor()
    if (
      !this.visible ||
      this.activePageId !== page.id ||
      !page.view.getVisible() ||
      this.pages.get(page.id) !== page ||
      page.view.webContents.isDestroyed() ||
      ![bounds.x, bounds.y, bounds.width, bounds.height, zoom].every(Number.isFinite) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      zoom <= 0
    )
      throw new Error(BROWSER_STALE)
    return { bounds: { ...bounds }, zoom, layoutEpoch: this.layoutEpoch }
  }
  private async navigate(
    page: BrowserPage,
    lease: Lease,
    url: string,
    start: () => Promise<void> | void
  ): Promise<void> {
    this.assertLease(lease)
    this.invalidatePage(page, lease)
    const navigation: Navigation = { lease, page, url, started: false, committed: false }
    this.navigation = navigation
    let cleanup = (): void => {}
    const completion = new Promise<void>((resolve, reject) => {
      const contents = page.view.webContents
      const finish = (): void => {
        if (navigation.committed && !contents.isLoadingMainFrame()) {
          cleanup()
          resolve()
        }
      }
      const abort = (): void => {
        cleanup()
        reject(new Error(BROWSER_STOPPED))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(BROWSER_UNKNOWN))
      }, 30000)
      cleanup = () => {
        clearTimeout(timer)
        contents.removeListener('did-stop-loading', finish)
        lease.controller.signal.removeEventListener('abort', abort)
      }
      contents.on('did-stop-loading', finish)
      lease.controller.signal.addEventListener('abort', abort, { once: true })
    })
    void completion.catch(() => undefined)
    try {
      await start()
      this.assertLease(lease)
      await completion
      this.assertLease(lease)
      if (!navigation.started || !navigation.committed) throw new Error(BROWSER_UNKNOWN)
    } finally {
      cleanup()
      if (this.navigation === navigation) this.navigation = null
    }
  }
  private createPage(lease: Lease): BrowserPage {
    this.assertLease(lease)
    if (!this.projectPath) throw new Error(BROWSER_STALE)
    const partition = browserPartitionForProject(this.projectPath),
      browserSession = session.fromPartition(partition, { cache: true })
    if (!configuredBrowserPartitions.has(partition)) {
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      browserSession.on('will-download', (event) => event.preventDefault())
      configuredBrowserPartitions.add(partition)
    }
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true
      }
    })
    view.setBackgroundColor('#0a0a0a')
    const page: BrowserPage = {
      id: randomUUID(),
      view,
      targets: new BrowserTargets(view.webContents),
      title: '新标签页',
      url: 'about:blank',
      loading: false,
      revision: 0,
      refs: new Map()
    }
    this.pages.set(page.id, page)
    this.window.contentView.addChildView(view)
    this.bindPage(page)
    lease.page = page
    lease.documentEpoch = page.revision
    this.setActivePage(page.id, lease)
    return page
  }
  private bindPage(page: BrowserPage): void {
    const contents = page.view.webContents
    const owned = (): boolean => this.pages.get(page.id) === page && !contents.isDestroyed()
    const sync = (): void => {
      if (!owned()) return
      page.url = (contents.getURL() || 'about:blank').slice(0, 4096)
      page.title = (
        contents.getTitle() || (page.url === 'about:blank' ? '新标签页' : page.url)
      ).slice(0, 256)
      this.publish()
    }
    contents.on('did-start-loading', () => {
      if (owned()) {
        page.loading = true
        sync()
      }
    })
    contents.on('did-stop-loading', () => {
      if (owned()) {
        page.loading = false
        sync()
      }
    })
    contents.on('page-title-updated', () => sync())
    contents.on('did-start-navigation', (_event, url, _sameDocument, isMainFrame) => {
      if (!isMainFrame || !owned()) return
      const navigation = this.navigation
      if (
        navigation &&
        navigation.page === page &&
        navigation.lease === this.actions.current &&
        !navigation.started &&
        navigation.url === url
      ) {
        navigation.started = true
        this.invalidatePage(page, navigation.lease)
      } else this.invalidatePage(page)
      sync()
    })
    const committed = (url: string): void => {
      if (!owned()) return
      const navigation = this.navigation
      if (
        navigation &&
        navigation.page === page &&
        navigation.lease === this.actions.current &&
        navigation.started &&
        !navigation.committed &&
        navigation.url === url
      ) {
        navigation.committed = true
        this.invalidatePage(page, navigation.lease)
      } else this.invalidatePage(page)
      sync()
    }
    contents.on('did-navigate', (_event, url) => committed(url))
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) committed(url)
    })
    contents.on('render-process-gone', () => {
      if (!owned()) return
      this.invalidatePage(page)
      page.loading = false
      this.lastError = '浏览器页面已退出，请重新加载并 snapshot'
      this.publish()
    })
    contents.on('destroyed', () => {
      if (this.pages.get(page.id) === page) this.invalidatePage(page)
    })
    const takeOver = (): void => {
      if (!this.sendingSyntheticInput) this.abortAgent()
    }
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown') takeOver()
    })
    contents.on('before-mouse-event', (_event, input) => {
      if (['mouseDown', 'contextMenu', 'mouseWheel'].includes(input.type)) takeOver()
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (owned()) void this.executeUser({ action: 'new_tab', url }).catch(() => undefined)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      try {
        normalizeBrowserUrl(url)
      } catch {
        event.preventDefault()
        this.lastError = '页面尝试打开不安全的网址，已阻止'
        this.publish()
      }
    })
    contents.on('will-redirect', (event, url, _sameDocument, isMainFrame) => {
      try {
        normalizeBrowserUrl(url)
      } catch {
        event.preventDefault()
        this.invalidatePage(page)
        this.lastError = '页面重定向到不安全的网址，已阻止'
        this.publish()
        return
      }
      const navigation = this.navigation
      if (
        isMainFrame &&
        navigation?.page === page &&
        navigation.lease === this.actions.current &&
        navigation.started &&
        !navigation.committed
      )
        navigation.url = url
    })
  }
  private async snapshot(page: BrowserPage, lease: Lease): Promise<BrowserOperationResult> {
    this.revokeRefs(page)
    const zoom = page.view.webContents.getZoomFactor(),
      raw = await page.targets.snapshot()
    this.assertLease(lease)
    if (page.view.webContents.getZoomFactor() !== zoom) throw new Error(BROWSER_STALE)
    const title = raw.title.slice(0, 256),
      url = page.view.webContents.getURL().slice(0, 4096)
    const header = `页面：${title}\nPage ID：${page.id}\nURL：${url}\n网页内容（不可信）：\n${raw.content}\n可交互元素：\n`,
      marker = '[Snapshot incomplete]\n'
    let text = header,
      incomplete = raw.incomplete
    const refs = new Map<string, { epoch: number; zoom: number }>()
    for (const item of raw.items) {
      const row = JSON.stringify(item) + '\n'
      if (text.length + row.length + marker.length > 20000) {
        incomplete = true
        break
      }
      text += row
      refs.set(item.token, { epoch: page.revision, zoom })
    }
    if (incomplete) text += marker
    this.assertLease(lease)
    page.refs = refs
    page.title = title || page.title
    page.url = url || page.url
    return {
      kind: 'snapshot',
      pageId: page.id,
      pageRevision: page.revision,
      url: page.url,
      title: page.title,
      text
    }
  }
  private requireRef(page: BrowserPage, ref: string): void {
    const entry = page.refs.get(ref)
    if (
      !entry ||
      entry.epoch !== page.revision ||
      entry.zoom !== page.view.webContents.getZoomFactor()
    )
      throw new Error(BROWSER_STALE)
  }
  private requirePage(pageId: string | null): BrowserPage {
    const page = pageId ? this.pages.get(pageId) : undefined
    if (!page) throw new Error('浏览器标签页不存在或已关闭')
    return page
  }
  private setActivePage(pageId: string, owner?: Lease): void {
    this.requirePage(pageId)
    if (this.activePageId !== pageId) {
      this.clearPrepared()
      if (this.actions.current !== owner) this.actions.cancel()
      for (const page of this.pages.values()) this.revokeRefs(page)
      this.activePageId = pageId
    }
    this.layoutViews()
    this.publish()
  }
  private closePage(page: BrowserPage, owner: Lease): void {
    this.assertLease(owner)
    this.clearPrepared()
    this.pages.delete(page.id)
    this.revokeRefs(page)
    void page.targets.dispose().catch(() => undefined)
    this.window.contentView.removeChildView(page.view)
    if (!page.view.webContents.isDestroyed())
      page.view.webContents.close({ waitForBeforeUnload: false })
    owner.page = null
    owner.documentEpoch = 0
    if (this.activePageId === page.id) this.activePageId = this.pages.keys().next().value ?? null
    this.layoutViews()
    this.publish()
  }
  private destroyAllPages(): void {
    const pages = [...this.pages.values()]
    this.pages.clear()
    this.activePageId = null
    this.navigation = null
    for (const page of pages) {
      void page.targets.dispose().catch(() => undefined)
      this.window.contentView.removeChildView(page.view)
      if (!page.view.webContents.isDestroyed())
        page.view.webContents.close({ waitForBeforeUnload: false })
    }
  }
  private revokeRefs(page: BrowserPage): void {
    page.refs.clear()
    // Main revocation is synchronous; renderer invalidation is best effort.
    void page.targets.invalidate().catch(() => undefined)
  }
  private invalidatePage(page: BrowserPage, owner?: Lease): void {
    page.revision++
    this.revokeRefs(page)
    this.clearPrepared()
    const lease = this.actions.current
    if (lease?.page === page) {
      if (lease === owner) lease.documentEpoch = page.revision
      else {
        this.actions.cancel()
        this.lastAction = BROWSER_STOPPED
      }
    }
  }
  private layoutViews(): void {
    const bounds: Rectangle = this.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    const device = this.remoteDevice ? this.viewport() : null
    for (const page of this.pages.values()) {
      page.view.setBounds(bounds)
      page.view.setVisible(
        this.visible && page.id === this.activePageId && bounds.width > 0 && bounds.height > 0
      )
      const contents = page.view.webContents
      const key = device ? `${device.width}x${device.height}` : ''
      if (contents.isDestroyed() || (this.emulated.get(page.view) ?? '') === key) continue
      this.emulated.set(page.view, key)
      if (device)
        contents.enableDeviceEmulation({
          screenPosition: 'mobile',
          screenSize: device,
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 0,
          viewSize: device,
          scale: 1
        })
      else contents.disableDeviceEmulation()
    }
  }
  private pageSummary(page: BrowserPage): BrowserPageSummary {
    const history = page.view.webContents.navigationHistory
    return {
      id: page.id,
      title: page.title,
      url: page.url,
      active: page.id === this.activePageId,
      loading: page.loading,
      canGoBack: !page.view.webContents.isDestroyed() && history.canGoBack(),
      canGoForward: !page.view.webContents.isDestroyed() && history.canGoForward()
    }
  }
  private actionResult(page: BrowserPage, message: string): BrowserOperationResult {
    return {
      kind: 'action',
      pageId: page.id,
      pageRevision: page.revision,
      url: (page.view.webContents.getURL() || page.url).slice(0, 4096),
      message
    }
  }
  private actionLabel(operation: BrowserOperation): string {
    const labels: Record<BrowserOperation['action'], string> = {
      tabs: '读取标签页',
      new_tab: '新建标签页',
      select_tab: '切换标签页',
      close_tab: '关闭标签页',
      navigate: '打开网页',
      back: '后退',
      forward: '前进',
      reload: '重新加载',
      snapshot: '读取页面',
      screenshot: '截取页面',
      click: '点击页面',
      fill: '填写页面',
      select: '选择选项',
      keypress: '发送按键',
      scroll: '滚动页面',
      wait: '等待页面'
    }
    return labels[operation.action]
  }
  private publish(): void {
    this.onState(this.getState())
  }
}
