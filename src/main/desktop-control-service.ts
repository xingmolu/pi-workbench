import {
  desktopControlAccessibilityPermissionResultSchema,
  desktopControlCommandSchema,
  type DesktopControlResult
} from '../shared/desktop-control'
import { DesktopAccessibility } from './desktop-control-accessibility'
import { DesktopCapture, type DesktopCaptureDeps } from './desktop-control-capture'
import { DesktopInput } from './desktop-control-input'
import {
  defaultNativeComputerUseExec,
  MacComputerUseBridge,
  type NativeComputerUseExec
} from './desktop-control-native'

export type DesktopControlServiceDeps = DesktopCaptureDeps & {
  nativeHelperPath: string
  appBundlePath: string
  nativeExec?: NativeComputerUseExec
}

/**
 * Main-owned Computer Use facade. Capture and native AX/CGEvent stay out of the renderer.
 * macOS automation is provided by the packaged Swift helper; no Apple Events/JXA path remains.
 */
export class DesktopControlService {
  readonly capture: DesktopCapture
  readonly accessibility: DesktopAccessibility
  readonly input: DesktopInput

  constructor(deps: DesktopControlServiceDeps) {
    const exec = deps.nativeExec ?? defaultNativeComputerUseExec()
    const bridge = new MacComputerUseBridge(deps.nativeHelperPath, exec)
    this.capture = new DesktopCapture({
      platform: deps.platform,
      getMediaAccessStatus: deps.getMediaAccessStatus,
      getSources: deps.getSources,
      getDisplays: deps.getDisplays,
      openExternal: deps.openExternal
    })
    this.accessibility = new DesktopAccessibility({
      platform: deps.platform,
      bridge,
      appBundlePath: deps.appBundlePath,
      openExternal: deps.openExternal,
      launchApp: async (args, signal) => {
        await exec('/usr/bin/open', args, { timeout: 10_000, ...(signal ? { signal } : {}) })
      }
    })
    this.input = new DesktopInput({
      platform: deps.platform,
      bridge
    })
  }

  async dispatch(command: unknown): Promise<DesktopControlResult> {
    const request = desktopControlCommandSchema.parse(command)
    if (
      request.type === 'permission' ||
      request.type === 'sources' ||
      request.type === 'open-screen-recording-settings'
    ) {
      return this.capture.dispatch(request)
    }
    if (request.type === 'accessibility-permission') {
      return desktopControlAccessibilityPermissionResultSchema.parse({
        type: 'accessibility-permission',
        permission: await this.accessibility.probePermission(false)
      })
    }
    if (request.type === 'accessibility-dump') {
      return this.accessibility.dump()
    }
    if (request.type === 'open-accessibility-settings') {
      return this.accessibility.openSettings()
    }
    const screen = this.capture.readPermission()
    const dump = await this.accessibility.dump()
    if (request.type === 'input-preview') {
      return this.input.preview({
        x: request.x,
        y: request.y,
        screen,
        accessibility: dump.permission,
        sessionUnlocked: dump.sessionUnlocked,
        dump: dump.dump
      })
    }
    return this.input.click({
      x: request.x,
      y: request.y,
      button: request.button,
      confirmed: true,
      screen,
      accessibility: dump.permission,
      sessionUnlocked: dump.sessionUnlocked,
      dump: dump.dump
    })
  }
}
