import type { BrowserState, WorkbenchContribution } from '../../../shared/contracts'

/** One tab in the workbench header: a tool, or one page of the browser. */
export type WorkbenchTabItem = {
  key: string
  viewId: string
  /** Set for a browser page; the browser contributes one tab per page. */
  pageId?: string
  title: string
  loading?: boolean
  contribution: WorkbenchContribution
}

export function isBrowserContribution(contribution: WorkbenchContribution): boolean {
  return contribution.surface.kind === 'native-view' && contribution.surface.adapter === 'browser'
}

export function workbenchTabItems(
  contributions: readonly WorkbenchContribution[],
  openedViewIds: readonly string[],
  browser: BrowserState,
  untitled: string
): WorkbenchTabItem[] {
  return openedViewIds.flatMap((viewId): WorkbenchTabItem[] => {
    const contribution = contributions.find((item) => item.viewId === viewId)
    if (!contribution) return []
    if (isBrowserContribution(contribution) && browser.pages.length)
      return browser.pages.map((page) => ({
        key: `${viewId}#${page.id}`,
        viewId,
        pageId: page.id,
        // A blank page reports its address as its title.
        title: !page.url || page.url === 'about:blank' ? untitled : page.title || page.url,
        loading: page.loading,
        contribution
      }))
    return [{ key: viewId, viewId, title: contribution.title, contribution }]
  })
}

export function isActiveTab(
  item: WorkbenchTabItem,
  selectedViewId: string | null,
  browser: BrowserState
): boolean {
  return item.viewId === selectedViewId && (!item.pageId || item.pageId === browser.activePageId)
}

/** The DOM id of a tab, which the open panel names as its label. */
export function workbenchTabId(viewId: string, pageId?: string | null): string {
  return pageId ? `workbench-tab-${viewId}-page-${pageId}` : `workbench-tab-${viewId}`
}
