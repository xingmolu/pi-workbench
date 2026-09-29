/**
 * Hash routes. A session route names its worker, which lives only as long as the desktop keeps
 * that session process, plus the project and session file so a reload after the worker is gone
 * (desktop restart, idle eviction, crash) can reopen the same conversation.
 */
export type MobileRoute =
  | { view: 'list' }
  | { view: 'session'; workerId: string; cwd?: string; path?: string }
  /** The desktop's browser and terminals; `viewId` is `browser` or `terminal:<id>`. */
  | { view: 'workbench'; viewId?: string }

export function parseRoute(hash: string): MobileRoute {
  const raw = hash.replace(/^#/, '')
  const [pathname, query = ''] = raw.split('?', 2) as [string, string?]
  const workbench = /^\/w(?:\/([^/?]+))?$/.exec(pathname)
  if (workbench) {
    try {
      return workbench[1]
        ? { view: 'workbench', viewId: decodeURIComponent(workbench[1]) }
        : { view: 'workbench' }
    } catch {
      return { view: 'workbench' }
    }
  }
  const match = /^\/s\/([^/?]+)$/.exec(pathname)
  if (!match) return { view: 'list' }
  let workerId: string
  try {
    workerId = decodeURIComponent(match[1]!)
  } catch {
    return { view: 'list' }
  }
  const params = new URLSearchParams(query)
  const cwd = params.get('cwd') || undefined
  const path = params.get('path') || undefined
  return { view: 'session', workerId, ...(cwd ? { cwd } : {}), ...(path ? { path } : {}) }
}

export function formatRoute(route: MobileRoute): string {
  if (route.view === 'list') return '/'
  if (route.view === 'workbench')
    return route.viewId ? `/w/${encodeURIComponent(route.viewId)}` : '/w'
  const params = new URLSearchParams()
  if (route.cwd) params.set('cwd', route.cwd)
  if (route.path) params.set('path', route.path)
  const query = params.toString()
  return `/s/${encodeURIComponent(route.workerId)}${query ? `?${query}` : ''}`
}
