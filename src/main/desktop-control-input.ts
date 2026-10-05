import {
  axNodeToHitTarget,
  desktopControlInputClickResultSchema,
  desktopControlInputPreviewResultSchema,
  hitTestAxNodes,
  type AxDump,
  type DesktopControlPermission,
  type DesktopControlResult,
  type DesktopWindowTarget
} from '../shared/desktop-control'
import { MacComputerUseBridge } from './desktop-control-native'
import { t } from '../shared/i18n'

export type DesktopInputDeps = {
  platform: string
  bridge: MacComputerUseBridge
}

export function inputGateMessage(input: {
  platformSupported: boolean
  sessionUnlocked: boolean
  accessibilityGranted: boolean
}): string | null {
  if (!input.platformSupported) return t('桌面输入仅在 macOS 上可用。')
  if (!input.sessionUnlocked) return t('锁屏或锁定会话中拒绝桌面输入。请解锁后再试。')
  if (!input.accessibilityGranted) return t('尚未确认辅助功能授权，拒绝桌面输入。')
  return null
}

export class DesktopInput {
  constructor(private readonly deps: DesktopInputDeps) {}

  preview(input: {
    x: number
    y: number
    screen: DesktopControlPermission
    accessibility: DesktopControlPermission
    sessionUnlocked: boolean
    dump: AxDump | null
  }): Extract<DesktopControlResult, { type: 'input-preview' }> {
    const platformSupported = this.deps.platform === 'darwin'
    const accessibilityGranted = input.accessibility.access === 'granted'
    const message = inputGateMessage({
      platformSupported,
      sessionUnlocked: input.sessionUnlocked,
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
    expectedTarget?: DesktopWindowTarget
    expiresAt?: number
    signal?: AbortSignal
  }): Promise<Extract<DesktopControlResult, { type: 'input-click' }>> {
    if (input.signal?.aborted) throw new Error(t('Computer Use 操作已停止'))
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
      await this.deps.bridge.call(
        {
          action: 'click',
          x: input.x,
          y: input.y,
          button: input.button ?? 'left',
          ...(input.expectedTarget ? { expectedTarget: input.expectedTarget } : {}),
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
        },
        input.signal
      )
      return desktopControlInputClickResultSchema.parse({
        type: 'input-click',
        executed: true,
        screen: input.screen,
        accessibility: input.accessibility,
        sessionUnlocked: input.sessionUnlocked,
        x: input.x,
        y: input.y,
        target: preview.target,
        message: t('已在确认坐标发送点击。')
      })
    } catch (error) {
      if (input.signal?.aborted) throw new Error(t('Computer Use 操作已停止'))
      if (input.expectedTarget) throw error
      return desktopControlInputClickResultSchema.parse({
        type: 'input-click',
        executed: false,
        screen: input.screen,
        accessibility: input.accessibility,
        sessionUnlocked: input.sessionUnlocked,
        x: input.x,
        y: input.y,
        target: preview.target,
        message: t('无法发送点击。请确认辅助功能授权后重试。')
      })
    }
  }

  async move(
    x: number,
    y: number,
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number
  ): Promise<void> {
    await this.deps.bridge.call(
      {
        action: 'move',
        x,
        y,
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      signal
    )
  }

  async typeText(
    text: string,
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number
  ): Promise<void> {
    await this.deps.bridge.call(
      {
        action: 'type',
        text,
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      signal
    )
  }

  async pressKey(
    key: string,
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number,
    modifiers: readonly string[] = []
  ): Promise<void> {
    await this.deps.bridge.call(
      {
        action: 'key',
        key,
        ...(modifiers.length ? { modifiers: [...modifiers] } : {}),
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      signal
    )
  }

  /** Wheel scroll in lines at a point; positive deltaY scrolls up, positive deltaX left. */
  async scroll(
    input: { x: number; y: number; deltaX: number; deltaY: number },
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number
  ): Promise<void> {
    await this.deps.bridge.call(
      {
        action: 'scroll',
        ...input,
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      signal
    )
  }

  async drag(
    input: { x: number; y: number; toX: number; toY: number },
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number
  ): Promise<void> {
    await this.deps.bridge.call(
      {
        action: 'drag',
        ...input,
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      signal
    )
  }

  /** Pastes through the clipboard, which the helper restores afterwards. */
  async paste(
    text: string,
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number
  ): Promise<void> {
    await this.deps.bridge.call(
      {
        action: 'paste',
        text,
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      signal
    )
  }

  async setValue(
    input: { x: number; y: number; value: string },
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget
  ): Promise<void> {
    const raw = asRecord(
      await this.deps.bridge.call(
        { action: 'set-value', ...input, ...(expectedTarget ? { expectedTarget } : {}) },
        signal
      )
    )
    if (raw?.ok === true) return
    throw new Error(
      raw?.error === 'not-settable'
        ? t('这个元素的值不能直接设置，请改用 type 或 paste')
        : t('无法设置元素的值')
    )
  }

  async secondary(
    input: { x: number; y: number; name: string },
    signal?: AbortSignal,
    expectedTarget?: DesktopWindowTarget,
    expiresAt?: number
  ): Promise<void> {
    const raw = asRecord(
      await this.deps.bridge.call(
        {
          action: 'ax-action',
          ...input,
          ...(expectedTarget ? { expectedTarget } : {}),
          ...(expiresAt ? { expiresAt } : {})
        },
        signal
      )
    )
    if (raw?.ok === true) return
    const available = Array.isArray(raw?.available) ? raw.available.join(', ') : ''
    throw new Error(
      t('这个元素不支持「{name}」操作{value}', {
        name: input.name,
        value: available ? t('（可用：{available}）', { available }) : ''
      })
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}
