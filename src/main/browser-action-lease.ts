export const BROWSER_STOPPED = '浏览器操作已停止；已派发的页面操作可能已经发生，请重新读取页面'
export const BROWSER_STALE = '页面或目标已变化，请重新 snapshot 后再操作'
export const BROWSER_UNKNOWN = '浏览器操作结果未知，请检查当前页面并重新 snapshot，不要自动重试'

export type BrowserActionLease<Page> = {
  readonly requestId: string
  readonly kind: 'user' | 'agent'
  readonly projectEpoch: number
  readonly controller: AbortController
  page: Page | null
  documentEpoch: number
}

/** Identity, rather than an action label or reusable request ID, owns completion. */
export class BrowserActionLeases<Page> {
  current: BrowserActionLease<Page> | null = null

  begin(
    kind: 'user' | 'agent',
    requestId: string,
    projectEpoch: number,
    page: Page | null,
    documentEpoch: number
  ): BrowserActionLease<Page> {
    this.cancel()
    const lease = {
      kind,
      requestId,
      projectEpoch,
      page,
      documentEpoch,
      controller: new AbortController()
    }
    this.current = lease
    return lease
  }

  assert(
    lease: BrowserActionLease<Page>,
    projectEpoch: number,
    page: Page | null,
    documentEpoch: number
  ): void {
    if (this.current !== lease || lease.controller.signal.aborted) throw new Error(BROWSER_STOPPED)
    if (
      lease.projectEpoch !== projectEpoch ||
      lease.page !== page ||
      lease.documentEpoch !== documentEpoch
    )
      throw new Error(BROWSER_STALE)
  }

  finish(lease: BrowserActionLease<Page>): boolean {
    if (this.current !== lease) return false
    this.current = null
    return true
  }

  cancel(): void {
    const lease = this.current
    this.current = null
    lease?.controller.abort()
  }
}

export function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(BROWSER_STOPPED))
      return
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      reject(new Error(BROWSER_STOPPED))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Stops waiting without claiming to withdraw already-dispatched renderer work. */
export function awaitBrowserAction<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(new Error(BROWSER_STOPPED))
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
