import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  cleanupWorkbenchPanelSessions,
  configureOwnedWorkbenchPanelSession,
  createWorkbenchPanelSessionOwnership
} from './workbench-panel-session'

function fakeSession(): {
  session: Session
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setDevicePermissionHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
  onBeforeRequest: ReturnType<typeof vi.fn>
  onHeadersReceived: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
} {
  const setPermissionCheckHandler = vi.fn()
  const setPermissionRequestHandler = vi.fn()
  const setDevicePermissionHandler = vi.fn()
  const setDisplayMediaRequestHandler = vi.fn()
  const onBeforeRequest = vi.fn()
  const onHeadersReceived = vi.fn()
  const on = vi.fn()
  const off = vi.fn()
  return {
    session: {
      setPermissionCheckHandler,
      setPermissionRequestHandler,
      setDevicePermissionHandler,
      setDisplayMediaRequestHandler,
      webRequest: { onBeforeRequest, onHeadersReceived },
      on,
      off
    } as unknown as Session,
    setPermissionCheckHandler,
    setPermissionRequestHandler,
    setDevicePermissionHandler,
    setDisplayMediaRequestHandler,
    onBeforeRequest,
    onHeadersReceived,
    on,
    off
  }
}

describe('Workbench panel session ownership', () => {
  it('clears only handlers still owned by the disposing host after partition reconfiguration', () => {
    const fake = fakeSession()
    const firstHost = createWorkbenchPanelSessionOwnership()
    const secondHost = createWorkbenchPanelSessionOwnership()
    const firstWebRequest = vi.fn()
    const secondWebRequest = vi.fn()

    configureOwnedWorkbenchPanelSession({
      partition: 'pi-workbench-shared',
      panelSession: fake.session,
      ownership: firstHost,
      configureWebRequest: firstWebRequest
    })
    const firstDownloadHandler = fake.on.mock.calls[0][1]
    configureOwnedWorkbenchPanelSession({
      partition: 'pi-workbench-shared',
      panelSession: fake.session,
      ownership: secondHost,
      configureWebRequest: secondWebRequest
    })
    const secondDownloadHandler = fake.on.mock.calls[1][1]

    expect(firstWebRequest).toHaveBeenCalledWith(fake.session)
    expect(secondWebRequest).toHaveBeenCalledWith(fake.session)
    expect(fake.off).toHaveBeenCalledWith('will-download', firstDownloadHandler)

    cleanupWorkbenchPanelSessions(firstHost)
    expect(fake.off).not.toHaveBeenCalledWith('will-download', secondDownloadHandler)
    expect(fake.onBeforeRequest).not.toHaveBeenCalledWith(null)
    expect(fake.onHeadersReceived).not.toHaveBeenCalledWith(null)
    expect(fake.setPermissionCheckHandler).not.toHaveBeenCalledWith(null)

    cleanupWorkbenchPanelSessions(secondHost)
    expect(fake.off).toHaveBeenCalledWith('will-download', secondDownloadHandler)
    expect(fake.onBeforeRequest).toHaveBeenCalledWith(null)
    expect(fake.onHeadersReceived).toHaveBeenCalledWith(null)
    expect(fake.setPermissionCheckHandler).toHaveBeenCalledWith(null)
    expect(fake.setPermissionRequestHandler).toHaveBeenCalledWith(null)
    expect(fake.setDevicePermissionHandler).toHaveBeenCalledWith(null)
    expect(fake.setDisplayMediaRequestHandler).toHaveBeenCalledWith(null)
  })
})
