import {
  axNodeToHitTarget,
  desktopControlInputClickResultSchema,
  desktopControlInputPreviewResultSchema,
  hitTestAxNodes,
  type AxDump,
  type DesktopControlPermission,
  type DesktopControlResult
} from '../shared/desktop-control'
import { jxaClick, jxaMove, jxaType, runJxa, type JxaExec } from './desktop-control-jxa'

export type DesktopInputDeps = {
  platform: string
  runJxa?: typeof runJxa
  exec: JxaExec
}

export function inputGateMessage(input: {
  platformSupported: boolean
  sessionUnlocked: boolean
  screenGranted: boolean
  accessibilityGranted: boolean
}): string | null {
  if (!input.platformSupported) return '桌面输入仅在 macOS 上可用。'
  if (!input.sessionUnlocked) return '锁屏或锁定会话中拒绝桌面输入。请解锁后再试。'
  if (!input.screenGranted) return '尚未确认屏幕录制授权，拒绝桌面输入。'
  if (!input.accessibilityGranted) return '尚未确认辅助功能授权，拒绝桌面输入。'
  return null
}

export class DesktopInput {
  constructor(private readonly deps: DesktopInputDeps) {}

  private invokeJxa(source: string): Promise<unknown> {
    return (this.deps.runJxa ?? runJxa)(this.deps.exec, source)
  }

  preview(input: {
    x: number
    y: number
    screen: DesktopControlPermission
    accessibility: DesktopControlPermission
    sessionUnlocked: boolean
    dump: AxDump | null
  }): Extract<DesktopControlResult, { type: 'input-preview' }> {
    const platformSupported = this.deps.platform === 'darwin'
    const screenGranted = input.screen.access === 'granted'
    const accessibilityGranted = input.accessibility.access === 'granted'
    const message = inputGateMessage({
      platformSupported,
      sessionUnlocked: input.sessionUnlocked,
      screenGranted,
      accessibilityGranted
    })
    const hit = input.dump ? hitTestAxNodes(input.dump.windows, input.x, input.y) : null
    return desktopControlInputPreviewResultSchema.parse({
      type: 'input-preview',
      screen: input.screen,
      accessibility: input.accessibility,
      sessionUnlocked: input.sessionUnlocked,
      allowed: message === null,
      x: input.x,
      y: input.y,
      target: hit ? axNodeToHitTarget(hit) : null,
      message: message ?? undefined
    })
  }

  async click(input: {
    x: number
    y: number
    button?: 'left' | 'right'
    confirmed: true
    screen: DesktopControlPermission
    accessibility: DesktopControlPermission
    sessionUnlocked: boolean
    dump: AxDump | null
  }): Promise<Extract<DesktopControlResult, { type: 'input-click' }>> {
    const preview = this.preview(input)
    if (!preview.allowed) {
      return desktopControlInputClickResultSchema.parse({
        type: 'input-click',
        executed: false,
        screen: input.screen,
        accessibility: input.accessibility,
        sessionUnlocked: input.sessionUnlocked,
        x: input.x,
        y: input.y,
        target: preview.target,
        message: preview.message
      })
    }
    try {
      await this.invokeJxa(jxaClick(input.x, input.y, input.button ?? 'left'))
      return desktopControlInputClickResultSchema.parse({
        type: 'input-click',
        executed: true,
        screen: input.screen,
        accessibility: input.accessibility,
        sessionUnlocked: input.sessionUnlocked,
        x: input.x,
        y: input.y,
        target: preview.target,
        message: '已在确认坐标发送点击。'
      })
    } catch {
      return desktopControlInputClickResultSchema.parse({
        type: 'input-click',
        executed: false,
        screen: input.screen,
        accessibility: input.accessibility,
        sessionUnlocked: input.sessionUnlocked,
        x: input.x,
        y: input.y,
        target: preview.target,
        message: '无法发送点击。请确认辅助功能授权后重试。'
      })
    }
  }

  async move(x: number, y: number): Promise<void> {
    await this.invokeJxa(jxaMove(x, y))
  }

  async typeText(text: string): Promise<void> {
    await this.invokeJxa(jxaType(text))
  }
}
