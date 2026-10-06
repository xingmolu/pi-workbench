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
useBrowserState.subscribe((store, previous) => {
  if (store.state !== previous.state) rememberSites(store.state)
})

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

/** A site visited in the workbench browser, offered again on the workbench's start page. */
export type RecentSite = { url: string; title: string }

const RECENT_KEY = 'pi-desktop.browser.recent'
const RECENT_LIMIT = 8

function readRecent(): RecentSite[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(value)
      ? value.filter(
          (site): site is RecentSite =>
            typeof site?.url === 'string' && typeof site?.title === 'string'
        )
      : []
  } catch {
    return []
  }
}

export const useRecentSites = create<{ sites: RecentSite[] }>(() => ({
  sites: typeof localStorage === 'undefined' ? [] : readRecent()
}))

/** Adds the loaded web pages to the recent sites, newest first. */
export function rememberSites(state: BrowserState): void {
  const visited = state.pages.filter(
    (page) => !page.loading && /^https?:\/\//.test(page.url) && page.title
  )
  if (!visited.length) return
  const current = useRecentSites.getState().sites
  const active = visited.find((page) => page.id === state.activePageId)
  const ordered = active ? [active, ...visited.filter((page) => page !== active)] : visited
  const next = [
    ...ordered.map(({ url, title }) => ({ url, title })),
    ...current.filter((site) => !visited.some((page) => page.url === site.url))
  ].slice(0, RECENT_LIMIT)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  useRecentSites.setState({ sites: next })
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Recent sites are a convenience; a full or blocked store only loses them.
  }
}

export function forgetSite(url: string): void {
  const sites = useRecentSites.getState().sites.filter((site) => site.url !== url)
  useRecentSites.setState({ sites })
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(sites))
  } catch {
    // See rememberSites.
  }
}

/** Opens a URL in the browser, reusing a blank page rather than adding another tab. */
export async function openInBrowser(url: string): Promise<void> {
  const { pages, activePageId } = useBrowserState.getState().state
  const blank = pages.find((page) => page.url === 'about:blank' || !page.url)
  if (!blank) return browserOperate({ action: 'new_tab', url })
  if (blank.id !== activePageId) await browserOperate({ action: 'select_tab', pageId: blank.id })
  return browserOperate({ action: 'navigate', url })
}
