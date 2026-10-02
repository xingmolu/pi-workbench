import { createHash } from 'node:crypto'
import { BROWSER_STOPPED } from './browser-action-lease'
import type { BrowserOperation, BrowserState } from '../shared/contracts'
import type {
  RemoteBrowserFrame,
  RemoteBrowserInput,
  RemoteBrowserState
} from '../shared/remote-views'
import { t } from '../shared/i18n'

type Image = {
  getSize(): { width: number; height: number }
  resize(options: { width: number }): Image
  toJPEG(quality: number): Buffer
}
export type RemoteBrowserSource = {
  captureActive(): Promise<{ image: Image; width: number; height: number } | null>
  getState(): BrowserState
  remoteInput(input: Extract<RemoteBrowserInput, { type: 'tap' | 'scroll' | 'text' | 'key' }>): void
  setRemoteDevice(mobile: boolean): void
  readonly remoteMobile: boolean
  executeUser(operation: BrowserOperation): Promise<unknown>
}
export type RemoteBrowserListener = (
  event: 'frame' | 'state',
  data: RemoteBrowserFrame | RemoteBrowserState
) => void

const MAX_IMAGE_WIDTH = 900
const UNAVAILABLE = t(
  '电脑上的浏览器暂时无法显示：请确认 Pi Desktop 窗口没有被最小化，电脑没有锁屏。'
)

/**
 * Streams the desktop browser to paired phones. Frames are captured only while someone
 * watches, faster right after input or while a page loads, and skipped when unchanged.
 */
export class RemoteBrowser {
  private readonly listeners = new Set<RemoteBrowserListener>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastHash = ''
  private burstUntil = 0
  private unavailable = false
  private capturing = false

  constructor(
    private readonly source: () => RemoteBrowserSource | null,
    /** Brings the browser panel (and a minimized window, on `wake`) into view on the desktop. */
    private readonly reveal: (wake: boolean) => void,
    private readonly timing = { idleMs: 800, activeMs: 250, burstMs: 4000 }
  ) {}

  get watching(): boolean {
    return this.listeners.size > 0
  }

  subscribe(listener: RemoteBrowserListener): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.reveal(false)
      this.burst()
    }
    this.lastHash = ''
    listener('state', this.state())
    this.schedule(0)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size) return
      clearTimeout(this.timer)
      this.timer = undefined
      // Leave the page as the desktop user knows it once no phone is looking.
      this.source()?.setRemoteDevice(false)
    }
  }

  /** Main forwards every browser state change; phones get tabs and navigation state. */
  changed(): void {
    if (!this.listeners.size) return
    this.burst()
    this.broadcast('state', this.state())
    this.schedule(0)
  }

  async input(input: RemoteBrowserInput): Promise<void> {
    const source = this.source()
    if (!source) throw new Error(t('浏览器工作台尚未就绪'))
    this.burst()
    switch (input.type) {
      case 'tap':
      case 'scroll':
      case 'text':
      case 'key':
        source.remoteInput(input)
        break
      case 'navigate': {
        // Watching reveals the panel, which opens its first tab asynchronously; a phone that
        // navigates before then gets a new tab instead of "no page". That startup tab's own
        // blank load can still land after this navigation began and stop it, so a stop is
        // retried once: the phone asked for this page, nobody else did.
        const open = (): Promise<unknown> =>
          source.executeUser(
            source.getState().pages.some((page) => page.active)
              ? { action: 'navigate', url: input.url }
              : { action: 'new_tab', url: input.url }
          )
        await open().catch(async (error: unknown) => {
          if (!(error instanceof Error) || error.message !== BROWSER_STOPPED) throw error
          await new Promise((resolve) => setTimeout(resolve, 150))
          await open()
        })
        break
      }
      case 'back':
      case 'forward':
      case 'reload':
        await source.executeUser({ action: input.type })
        break
      case 'new_tab':
        await source.executeUser({ action: 'new_tab' })
        break
      case 'select_tab':
      case 'close_tab':
        await source.executeUser({ action: input.type, pageId: input.pageId })
        break
      case 'device':
        source.setRemoteDevice(input.mobile)
        break
      case 'wake':
        this.unavailable = false
        this.reveal(true)
        break
    }
    this.lastHash = ''
    this.schedule(input.type === 'tap' || input.type === 'scroll' ? 60 : 0)
  }

  private state(): RemoteBrowserState {
    const source = this.source()
    const state = source?.getState()
    const active = state?.pages.find((page) => page.active)
    return {
      available: Boolean(state?.available),
      tabs: (state?.pages ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        url: page.url,
        active: page.active,
        loading: page.loading
      })),
      canGoBack: Boolean(active?.canGoBack),
      canGoForward: Boolean(active?.canGoForward),
      mobile: Boolean(source?.remoteMobile),
      controller: state?.controller ?? 'idle',
      ...(!state?.available
        ? { message: t('电脑上还没有打开项目，浏览器不可用。') }
        : this.unavailable
          ? { message: UNAVAILABLE }
          : state.error
            ? { message: state.error }
            : {})
    }
  }

  private burst(): void {
    this.burstUntil = Date.now() + this.timing.burstMs
  }

  private schedule(delay: number): void {
    if (!this.listeners.size || this.capturing) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.capture(), delay)
  }

  private async capture(): Promise<void> {
    this.timer = undefined
    const source = this.source()
    if (!source || !this.listeners.size) return
    this.capturing = true
    let loading = false
    try {
      loading = source.getState().pages.some((page) => page.active && page.loading)
      const shot = await source.captureActive().catch(() => null)
      const missing = !shot
      if (missing !== this.unavailable) {
        this.unavailable = missing
        this.broadcast('state', this.state())
      }
      if (shot && this.listeners.size) {
        let image = shot.image
        if (image.getSize().width > MAX_IMAGE_WIDTH)
          image = image.resize({ width: MAX_IMAGE_WIDTH })
        const jpeg = image.toJPEG(62)
        const hash = createHash('sha1').update(jpeg).digest('hex')
        if (hash !== this.lastHash) {
          this.lastHash = hash
          this.broadcast('frame', {
            data: jpeg.toString('base64'),
            width: shot.width,
            height: shot.height
          })
        }
      }
    } finally {
      this.capturing = false
    }
    const active = loading || Date.now() < this.burstUntil
    this.schedule(active ? this.timing.activeMs : this.timing.idleMs)
  }

  private broadcast(event: 'frame' | 'state', data: RemoteBrowserFrame | RemoteBrowserState): void {
    for (const listener of this.listeners) listener(event, data)
  }
}
