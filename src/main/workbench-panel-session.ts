import type { Event, Session } from 'electron'

export type WorkbenchPanelSessionOwnership = {
  owner: object
  partitions: Set<string>
}

const configuredSessions = new Map<
  string,
  {
    owner: object
    panelSession: Session
    downloadHandler: (event: Event) => void
  }
>()

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // A closing Electron session may reject individual cleanup calls.
  }
}

export function createWorkbenchPanelSessionOwnership(): WorkbenchPanelSessionOwnership {
  return { owner: {}, partitions: new Set() }
}

export function configureOwnedWorkbenchPanelSession(options: {
  partition: string
  panelSession: Session
  ownership: WorkbenchPanelSessionOwnership
  configureWebRequest(panelSession: Session): void
}): void {
  if (options.partition.startsWith('persist:')) {
    throw new Error('Workbench partitions must be ephemeral')
  }

  const previous = configuredSessions.get(options.partition)
  if (previous) {
    previous.panelSession.off('will-download', previous.downloadHandler)
  }

  options.panelSession.setPermissionCheckHandler(() => false)
  options.panelSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  options.panelSession.setDevicePermissionHandler(() => false)
  options.panelSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  options.configureWebRequest(options.panelSession)

  const downloadHandler = (event: Event): void => event.preventDefault()
  options.panelSession.on('will-download', downloadHandler)
  configuredSessions.set(options.partition, {
    owner: options.ownership.owner,
    panelSession: options.panelSession,
    downloadHandler
  })
  options.ownership.partitions.add(options.partition)
}

export function cleanupWorkbenchPanelSessions(ownership: WorkbenchPanelSessionOwnership): void {
  for (const partition of ownership.partitions) {
    const configured = configuredSessions.get(partition)
    if (!configured || configured.owner !== ownership.owner) continue
    configuredSessions.delete(partition)
    safely(() => configured.panelSession.off('will-download', configured.downloadHandler))
    safely(() => configured.panelSession.webRequest.onBeforeRequest(null))
    safely(() => configured.panelSession.webRequest.onHeadersReceived(null))
    safely(() => configured.panelSession.setPermissionCheckHandler(null))
    safely(() => configured.panelSession.setPermissionRequestHandler(null))
    safely(() => configured.panelSession.setDevicePermissionHandler(null))
    safely(() => configured.panelSession.setDisplayMediaRequestHandler(null))
  }
  ownership.partitions.clear()
}
