import { create } from 'zustand'
import type { BrowserCommand, BrowserOperation, BrowserState } from '../../../shared/contracts'

export const EMPTY_BROWSER_STATE: BrowserState = {
  available: false,
  visible: false,
  pages: [],
  activePageId: null,
  controller: 'idle'
}

type BrowserStore = { state: BrowserState; error: string | null }

/** The workbench browser's pages, shared by its tabs in the workbench header and its pane. */
export const useBrowserState = create<BrowserStore>(() => ({
  state: EMPTY_BROWSER_STATE,
  error: null
}))

let started = false
/** Starts following the browser's state; later calls do nothing. */
export function followBrowserState(): void {
  if (started || typeof window === 'undefined' || !window.pi?.onBrowserEvent) return
  started = true
  window.pi.onBrowserEvent((event) => useBrowserState.setState({ state: event.data }))
  void window.pi
    .browser({ type: 'state:get' })
    .then((result) => useBrowserState.setState({ state: result.state }))
    .catch((error: unknown) =>
      useBrowserState.setState({ error: error instanceof Error ? error.message : String(error) })
    )
}

export async function browserCommand(command: BrowserCommand): Promise<void> {
  try {
    const result = await window.pi.browser(command)
    useBrowserState.setState({ state: result.state, error: null })
  } catch (error) {
    useBrowserState.setState({ error: error instanceof Error ? error.message : String(error) })
  }
}

export const browserOperate = (operation: BrowserOperation): Promise<void> =>
  browserCommand({ type: 'operate', operation })

/** What the address bar sends: a URL as typed, or a web search for anything else. */
export function addressTarget(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/\s/.test(text)) return text
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)) return text
  if (!/\s/.test(text) && /^[^/?#]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(text)) return text
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}
