import type { WorkbenchEvent, WorkbenchSnapshot } from '../../../shared/contracts'

type WorkbenchEventCoordinatorOptions = {
  subscribe(listener: (event: WorkbenchEvent) => void): () => void
  getState(): Promise<{ state: WorkbenchSnapshot }>
  onSnapshot(snapshot: WorkbenchSnapshot): void
  onReveal(viewId: string): void
  onError(message: string): void
  onToast?(pluginId: string, message: string): void
  onApproval?(
    event: Extract<WorkbenchEvent, { type: 'plugin-approval' | 'plugin-approval-closed' }>
  ): void
  onChatDraft?(pluginId: string, text: string): void
  onOpenSettings?(section: 'forges'): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startWorkbenchEventCoordinator(
  options: WorkbenchEventCoordinatorOptions
): () => void {
  let cancelled = false
  let revision = -1
  let initialized = false
  let availableViewIds = new Set<string>()
  const pendingReveals: string[] = []
  let refreshInFlight: Promise<void> | null = null

  const acceptReveal = (viewId: string): void => {
    if (cancelled || !availableViewIds.has(viewId)) return
    options.onReveal(viewId)
  }

  const acceptSnapshot = (snapshot: WorkbenchSnapshot): void => {
    if (cancelled || snapshot.revision <= revision) return
    revision = snapshot.revision
    initialized = true
    availableViewIds = new Set(snapshot.contributions.map(({ viewId }) => viewId))
    options.onSnapshot(snapshot)
    pendingReveals.splice(0).forEach(acceptReveal)
  }

  const refresh = (): void => {
    if (cancelled || refreshInFlight) return
    let response: Promise<{ state: WorkbenchSnapshot }>
    try {
      response = options.getState()
    } catch (error) {
      options.onError(errorMessage(error))
      return
    }
    const request = response.then(
      ({ state }) => acceptSnapshot(state),
      (error: unknown) => {
        if (!cancelled) options.onError(errorMessage(error))
      }
    )
    refreshInFlight = request
    void request.then(() => {
      if (refreshInFlight === request) refreshInFlight = null
    })
  }

  const unsubscribe = options.subscribe((event) => {
    if (event.type === 'state') acceptSnapshot(event.data)
    else if (event.type === 'toast') {
      if (!cancelled) options.onToast?.(event.pluginId, event.message)
    } else if (event.type === 'plugin-approval' || event.type === 'plugin-approval-closed') {
      if (!cancelled) options.onApproval?.(event)
    } else if (event.type === 'chat-draft') {
      if (!cancelled) options.onChatDraft?.(event.pluginId, event.text)
    } else if (event.type === 'open-settings') {
      if (!cancelled) options.onOpenSettings?.(event.section)
    } else if (!initialized) {
      pendingReveals.push(event.viewId)
      refresh()
    } else acceptReveal(event.viewId)
  })

  refresh()

  return () => {
    if (cancelled) return
    cancelled = true
    unsubscribe()
  }
}
