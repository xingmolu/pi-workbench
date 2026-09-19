import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  axNodeToHitTarget,
  desktopControlAccessibilityPermissionResultSchema,
  desktopControlAgentOperationSchema,
  desktopControlAgentResultSchema,
  desktopControlCommandSchema,
  desktopControlGateMessage,
  hitTestAxNodes,
  type DesktopControlAgentOperation,
  type DesktopControlAgentResult,
  type DesktopControlResult
} from '../shared/desktop-control'
import { DesktopAccessibility } from './desktop-control-accessibility'
import { DesktopCapture, type DesktopCaptureDeps } from './desktop-control-capture'
import { DesktopInput, inputGateMessage } from './desktop-control-input'
import { type JxaExec } from './desktop-control-jxa'

const execFileAsync = promisify(execFile)

export function defaultJxaExec(): JxaExec {
  return (file, args, options) => execFileAsync(file, [...args], options)
}

export type DesktopControlServiceDeps = DesktopCaptureDeps & {
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean
  exec?: JxaExec
}

/**
 * Main-owned Computer Use facade. Capture, AX, and CGEvent/JXA stay out of the renderer.
 * nut-js is intentionally not used: Electron 44 + ad-hoc codesign would need a native rebuild.
 */
export class DesktopControlService {
  readonly capture: DesktopCapture
  readonly accessibility: DesktopAccessibility
  readonly input: DesktopInput

  constructor(deps: DesktopControlServiceDeps) {
    const exec = deps.exec ?? defaultJxaExec()
    this.capture = new DesktopCapture({
      platform: deps.platform,
      getMediaAccessStatus: deps.getMediaAccessStatus,
      getSources: deps.getSources,
      openExternal: deps.openExternal
    })
    this.accessibility = new DesktopAccessibility({
      platform: deps.platform,
      isTrustedAccessibilityClient: deps.isTrustedAccessibilityClient,
      exec,
      openExternal: deps.openExternal
    })
    this.input = new DesktopInput({
      platform: deps.platform,
      exec
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
        permission: this.accessibility.readPermission()
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

  async executeAgent(
    operation: unknown,
    signal?: AbortSignal
  ): Promise<DesktopControlAgentResult> {
    if (signal?.aborted) throw new Error('桌面控制操作已停止')
    const request: DesktopControlAgentOperation = desktopControlAgentOperationSchema.parse(operation)
    const screen = this.capture.readPermission()
    const platformSupported = screen.platformSupported
    const dump = await this.accessibility.dump(signal)
    const gate = desktopControlGateMessage({
      platformSupported,
      sessionUnlocked: dump.sessionUnlocked,
      accessibilityGranted: dump.permission.access === 'granted'
    })
    if (gate) throw new Error(gate)
    if (request.action === 'dump') {
      if (!dump.dump) throw new Error(dump.message ?? '无法读取窗口结构。')
      return desktopControlAgentResultSchema.parse({
        kind: 'dump',
        dump: dump.dump,
        sessionUnlocked: dump.sessionUnlocked
      })
    }
    if (request.action === 'hit_test') {
      const hit = dump.dump ? hitTestAxNodes(dump.dump.windows, request.x, request.y) : null
      return desktopControlAgentResultSchema.parse({
        kind: 'hit-test',
        app: dump.dump?.app ?? '',
        target: hit ? axNodeToHitTarget(hit) : null,
        sessionUnlocked: dump.sessionUnlocked
      })
    }
    const inputGate = inputGateMessage({
      platformSupported,
      sessionUnlocked: dump.sessionUnlocked,
      accessibilityGranted: dump.permission.access === 'granted'
    })
    if (inputGate) throw new Error(inputGate)
    if (request.action === 'click') {
      const clicked = await this.input.click({
        x: request.x,
        y: request.y,
        button: request.button,
        confirmed: true,
        screen,
        accessibility: dump.permission,
        sessionUnlocked: dump.sessionUnlocked,
        dump: dump.dump,
        signal
      })
      if (!clicked.executed) throw new Error(clicked.message ?? '无法发送点击。')
      return desktopControlAgentResultSchema.parse({
        kind: 'action',
        action: 'click',
        message: clicked.message ?? '已在确认坐标发送点击。',
        x: request.x,
        y: request.y
      })
    }
    if (request.action === 'move') {
      await this.input.move(request.x, request.y, signal)
      return desktopControlAgentResultSchema.parse({
        kind: 'action',
        action: 'move',
        message: '已移动指针。',
        x: request.x,
        y: request.y
      })
    }
    await this.input.typeText(request.text, signal)
    return desktopControlAgentResultSchema.parse({
      kind: 'action',
      action: 'type',
      message: `已输入 ${request.text.length} 个字符。`
    })
  }
}
