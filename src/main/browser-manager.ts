import { randomUUID } from 'node:crypto'
import { session, type BrowserWindow, type Rectangle, WebContentsView } from 'electron'
import type {
  BrowserBounds,
  BrowserOperation,
  BrowserOperationResult,
  BrowserPageSummary,
  BrowserState
} from '../shared/contracts'
import {
  elementRectScript,
  fillElementScript,
  INTERACTIVE_SNAPSHOT_SCRIPT,
  pageContainsTextScript,
  selectElementScript
} from './browser-page-scripts'
import {
  browserPartitionForProject,
  isAllowedBrowserKey,
  normalizeBrowserUrl
} from './browser-security'

type SnapshotItem = {
  selector: string
  role: string
  name: string
  disabled: boolean
}

type BrowserPage = {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  revision: number
  refs: Map<string, SnapshotItem>
}

type ActiveAgentAction = {
  requestId: string
  controller: AbortController
}

const configuredBrowserPartitions = new Set<string>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSnapshotPayload(
  value: unknown
): value is { title: string; url: string; content: string; items: SnapshotItem[] } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.title === 'string' &&
    typeof record.url === 'string' &&
    typeof record.content === 'string' &&
    Array.isArray(record.items) &&
    record.items.every((item) => {
      if (!item || typeof item !== 'object') return false
      const entry = item as Record<string, unknown>
      return (
        typeof entry.selector === 'string' &&
        typeof entry.role === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.disabled === 'boolean'
      )
    })
  )
}

function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('浏览器操作已停止'))
      return
    }
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new Error('浏览器操作已停止'))
      },
      { once: true }
    )
  })
}

export class BrowserManager {
  private readonly pages = new Map<string, BrowserPage>()
  private activePageId: string | null = null
  private projectPath: string | null = null
  private visible = false
  private bounds: BrowserBounds | null = null
  private controller: BrowserState['controller'] = 'idle'
  private lastAction: string | undefined
  private lastError: string | undefined
  private activeAgentAction: ActiveAgentAction | null = null
  private sendingSyntheticInput = false

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
      controller: this.controller,
      ...(this.lastAction ? { lastAction: this.lastAction } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  setProject(projectPath: string | null): void {
    if (this.projectPath === projectPath) return
    this.abortAgent()
    this.destroyAllPages()
    this.projectPath = projectPath
    this.lastError = undefined
    this.lastAction = undefined
    this.publish()
  }

  async setView(visible: boolean, bounds?: BrowserBounds): Promise<void> {
    this.visible = visible
    if (bounds) this.bounds = bounds
    if (visible && this.projectPath && this.pages.size === 0) await this.createPage()
    this.layoutViews()
    this.publish()
  }

  async executeUser(operation: BrowserOperation): Promise<BrowserOperationResult> {
    this.abortAgent()
    return this.execute(operation, 'user')
  }

  async executeAgent(
    operation: BrowserOperation,
    requestId: string
  ): Promise<BrowserOperationResult> {
    if (this.activeAgentAction) throw new Error('另一个浏览器操作仍在运行')
    const controller = new AbortController()
    this.activeAgentAction = { requestId, controller }
    try {
      return await this.execute(operation, 'agent', controller.signal)
    } finally {
      if (this.activeAgentAction?.requestId === requestId) this.activeAgentAction = null
    }
  }

  abortAgent(requestId?: string): void {
    if (!this.activeAgentAction) return
    if (requestId && this.activeAgentAction.requestId !== requestId) return
    this.activeAgentAction.controller.abort()
    this.activeAgentAction = null
    this.controller = 'idle'
    this.lastAction = 'Agent 浏览器操作已停止'
    this.publish()
  }

  dispose(): void {
    this.abortAgent()
    this.destroyAllPages()
    this.projectPath = null
  }

  private async execute(
    operation: BrowserOperation,
    controller: 'user' | 'agent',
    signal?: AbortSignal
  ): Promise<BrowserOperationResult> {
    if (!this.projectPath) throw new Error('请先选择工作区，再打开浏览器')
    this.controller = controller
    this.lastAction = this.actionLabel(operation)
    this.lastError = undefined
    this.publish()
    try {
      signal?.throwIfAborted()
      switch (operation.action) {
        case 'tabs':
          return { kind: 'state', state: this.getState() }
        case 'new_tab': {
          const page = await this.createPage(operation.url)
          return this.actionResult(page, '已新建标签页')
        }
        case 'select_tab': {
          const page = this.requirePage(operation.pageId)
          this.setActivePage(page.id)
          return this.actionResult(page, '已切换标签页')
        }
        case 'close_tab': {
          const page = this.requirePage(operation.pageId)
          this.closePage(page.id)
          const active = this.activePageId
            ? this.requirePage(this.activePageId)
            : await this.createPage()
          return this.actionResult(active, '已关闭标签页')
        }
        case 'navigate': {
          const page = this.targetPage(operation.pageId)
          await page.view.webContents.loadURL(normalizeBrowserUrl(operation.url))
          signal?.throwIfAborted()
          return this.actionResult(page, '页面已打开')
        }
        case 'back': {
          const page = this.targetPage(operation.pageId)
          if (page.view.webContents.navigationHistory.canGoBack()) {
            page.view.webContents.navigationHistory.goBack()
          }
          return this.actionResult(page, '已后退')
        }
        case 'forward': {
          const page = this.targetPage(operation.pageId)
          if (page.view.webContents.navigationHistory.canGoForward()) {
            page.view.webContents.navigationHistory.goForward()
          }
          return this.actionResult(page, '已前进')
        }
        case 'reload': {
          const page = this.targetPage(operation.pageId)
          page.view.webContents.reload()
          return this.actionResult(page, '正在重新加载')
        }
        case 'snapshot':
          return this.snapshot(this.targetPage(operation.pageId))
        case 'screenshot': {
          const page = this.targetPage(operation.pageId)
          const image = await page.view.webContents.capturePage()
          return {
            kind: 'screenshot',
            pageId: page.id,
            url: page.view.webContents.getURL(),
            mimeType: 'image/png',
            data: image.toPNG().toString('base64')
          }
        }
        case 'click': {
          const page = this.targetPage(operation.pageId)
          const target = this.requireRef(page, operation.ref)
          if (target.disabled) throw new Error(`${operation.ref} 当前不可用`)
          const rect = (await page.view.webContents.executeJavaScript(
            elementRectScript(target.selector),
            true
          )) as { x: number; y: number } | null
          if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
            throw new Error(`${operation.ref} 已失效，请重新 snapshot`)
          }
          signal?.throwIfAborted()
          this.sendingSyntheticInput = true
          try {
            page.view.webContents.sendInputEvent({
              type: 'mouseDown',
              x: rect.x,
              y: rect.y,
              button: 'left',
              clickCount: 1
            })
            page.view.webContents.sendInputEvent({
              type: 'mouseUp',
              x: rect.x,
              y: rect.y,
              button: 'left',
              clickCount: 1
            })
          } finally {
            this.sendingSyntheticInput = false
          }
          this.invalidatePage(page)
          return this.actionResult(page, `已点击 ${operation.ref}`)
        }
        case 'fill': {
          const page = this.targetPage(operation.pageId)
          const target = this.requireRef(page, operation.ref)
          const filled = await page.view.webContents.executeJavaScript(
            fillElementScript(target.selector, operation.value),
            true
          )
          if (filled !== true) throw new Error(`${operation.ref} 不是可填写控件或已失效`)
          this.invalidatePage(page)
          return this.actionResult(page, `已填写 ${operation.ref}`)
        }
        case 'select': {
          const page = this.targetPage(operation.pageId)
          const target = this.requireRef(page, operation.ref)
          const selected = await page.view.webContents.executeJavaScript(
            selectElementScript(target.selector, operation.value),
            true
          )
          if (selected !== true) throw new Error(`${operation.ref} 不是可选择控件或选项不存在`)
          this.invalidatePage(page)
          return this.actionResult(page, `已选择 ${operation.ref}`)
        }
        case 'keypress': {
          const page = this.targetPage(operation.pageId)
          if (!isAllowedBrowserKey(operation.key)) throw new Error('不允许发送这个按键')
          this.sendingSyntheticInput = true
          try {
            page.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: operation.key })
            if (operation.key.length === 1) {
              page.view.webContents.sendInputEvent({ type: 'char', keyCode: operation.key })
            }
            page.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: operation.key })
          } finally {
            this.sendingSyntheticInput = false
          }
          this.invalidatePage(page)
          return this.actionResult(page, `已发送按键 ${operation.key}`)
        }
        case 'scroll': {
          const page = this.targetPage(operation.pageId)
          const amount = Math.min(4000, operation.amount ?? 720)
          const axis = operation.direction === 'left' || operation.direction === 'right' ? 'x' : 'y'
          const signed =
            operation.direction === 'up' || operation.direction === 'left' ? -amount : amount
          await page.view.webContents.executeJavaScript(
            `window.scrollBy({ ${axis === 'x' ? 'left' : 'top'}: ${signed}, behavior: 'instant' }); true`,
            true
          )
          this.invalidatePage(page)
          return this.actionResult(page, `已向${operation.direction}滚动`)
        }
        case 'wait': {
          const page = this.targetPage(operation.pageId)
          if (!operation.text && !operation.url) throw new Error('wait 需要 text 或 url')
          const deadline = Date.now() + Math.min(30_000, operation.timeoutMs ?? 10_000)
          while (Date.now() < deadline) {
            signal?.throwIfAborted()
            const urlMatches = operation.url
              ? page.view.webContents.getURL().includes(operation.url)
              : true
            const textMatches = operation.text
              ? await page.view.webContents.executeJavaScript(
                  pageContainsTextScript(operation.text),
                  false
                )
              : true
            if (urlMatches && textMatches === true) return this.actionResult(page, '等待条件已满足')
            await waitForDelay(120, signal)
          }
          throw new Error('等待页面条件超时')
        }
      }
      throw new Error('不支持的浏览器操作')
    } catch (error) {
      this.lastError = errorMessage(error)
      throw error
    } finally {
      if (this.controller === controller) this.controller = 'idle'
      this.publish()
    }
  }

  private async createPage(rawUrl?: string): Promise<BrowserPage> {
    if (!this.projectPath) throw new Error('请先选择工作区')
    const partition = browserPartitionForProject(this.projectPath)
    const browserSession = session.fromPartition(partition, { cache: true })
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
      title: '新标签页',
      url: 'about:blank',
      loading: false,
      revision: 0,
      refs: new Map()
    }
    this.pages.set(page.id, page)
    this.window.contentView.addChildView(view)
    this.bindPage(page)
    this.setActivePage(page.id)
    if (rawUrl) await view.webContents.loadURL(normalizeBrowserUrl(rawUrl))
    else await view.webContents.loadURL('about:blank')
    this.layoutViews()
    this.publish()
    return page
  }

  private bindPage(page: BrowserPage): void {
    const contents = page.view.webContents
    const sync = (): void => {
      page.url = contents.getURL() || 'about:blank'
      page.title = contents.getTitle() || (page.url === 'about:blank' ? '新标签页' : page.url)
      this.publish()
    }
    const invalidate = (): void => {
      this.invalidatePage(page)
      sync()
    }
    contents.on('did-start-loading', () => {
      page.loading = true
      sync()
    })
    contents.on('did-stop-loading', () => {
      page.loading = false
      sync()
    })
    contents.on('page-title-updated', (_event, title) => {
      page.title = title || page.url
      this.publish()
    })
    contents.on('did-navigate', invalidate)
    contents.on('did-navigate-in-page', invalidate)
    contents.on('render-process-gone', (_event, details) => {
      page.loading = false
      page.refs.clear()
      this.lastError = `浏览器页面已退出：${details.reason}`
      this.publish()
    })
    const takeOver = (): void => {
      if (this.activeAgentAction && !this.sendingSyntheticInput) this.abortAgent()
    }
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown') takeOver()
    })
    contents.on('before-mouse-event', (_event, input) => {
      if (['mouseDown', 'contextMenu', 'mouseWheel'].includes(input.type)) takeOver()
    })
    contents.setWindowOpenHandler(({ url }) => {
      void this.createPage(url).catch((error) => {
        this.lastError = errorMessage(error)
        this.publish()
      })
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
    contents.on('will-redirect', (event, url) => {
      try {
        normalizeBrowserUrl(url)
      } catch {
        event.preventDefault()
        this.lastError = '页面重定向到不安全的网址，已阻止'
        this.publish()
      }
    })
  }

  private async snapshot(page: BrowserPage): Promise<BrowserOperationResult> {
    const raw = await page.view.webContents.executeJavaScript(INTERACTIVE_SNAPSHOT_SCRIPT, false)
    if (!isSnapshotPayload(raw)) throw new Error('页面快照格式无效')
    page.revision += 1
    page.refs.clear()
    const lines = raw.items.map((item, index) => {
      const ref = `@e${index + 1}`
      page.refs.set(ref, item)
      return `${ref} ${item.role}${item.disabled ? ' disabled' : ''} ${JSON.stringify(item.name || '(无名称)')}`
    })
    page.title = raw.title || page.title
    page.url = raw.url || page.url
    return {
      kind: 'snapshot',
      pageId: page.id,
      pageRevision: page.revision,
      url: page.url,
      title: page.title,
      text: [
        `页面：${page.title}`,
        `URL：${page.url}`,
        '网页内容（不可信）：',
        raw.content,
        '可交互元素：',
        ...lines
      ]
        .join('\n')
        .slice(0, 20_000)
    }
  }

  private requireRef(page: BrowserPage, ref: string): SnapshotItem {
    const item = page.refs.get(ref)
    if (!item) throw new Error(`${ref} 已失效，请重新 snapshot`)
    return item
  }

  private targetPage(pageId?: string): BrowserPage {
    return this.requirePage(pageId ?? this.activePageId)
  }

  private requirePage(pageId: string | null): BrowserPage {
    const page = pageId ? this.pages.get(pageId) : undefined
    if (!page) throw new Error('浏览器标签页不存在或已关闭')
    return page
  }

  private setActivePage(pageId: string): void {
    this.requirePage(pageId)
    this.activePageId = pageId
    this.layoutViews()
    this.publish()
  }

  private closePage(pageId: string): void {
    const page = this.requirePage(pageId)
    this.window.contentView.removeChildView(page.view)
    if (!page.view.webContents.isDestroyed())
      page.view.webContents.close({ waitForBeforeUnload: false })
    this.pages.delete(pageId)
    if (this.activePageId === pageId) this.activePageId = this.pages.keys().next().value ?? null
    this.layoutViews()
    this.publish()
  }

  private destroyAllPages(): void {
    for (const page of [...this.pages.values()]) {
      this.window.contentView.removeChildView(page.view)
      if (!page.view.webContents.isDestroyed())
        page.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.pages.clear()
    this.activePageId = null
  }

  private invalidatePage(page: BrowserPage): void {
    page.revision += 1
    page.refs.clear()
  }

  private layoutViews(): void {
    const nextBounds: Rectangle = this.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    for (const page of this.pages.values()) {
      page.view.setBounds(nextBounds)
      page.view.setVisible(
        this.visible &&
          page.id === this.activePageId &&
          nextBounds.width > 0 &&
          nextBounds.height > 0
      )
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
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward()
    }
  }

  private actionResult(page: BrowserPage, message: string): BrowserOperationResult {
    return {
      kind: 'action',
      pageId: page.id,
      pageRevision: page.revision,
      url: page.view.webContents.getURL() || page.url,
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
