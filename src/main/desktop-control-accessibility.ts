import {
  ACCESSIBILITY_SETTINGS_URLS,
  axDumpSchema,
  desktopControlAccessibilityDumpResultSchema,
  desktopControlOpenSettingsResultSchema,
  desktopControlPermissionSchema,
  desktopWindowTargetSchema,
  mapScreenRecordingAccess,
  type DesktopControlPermission,
  type DesktopControlResult,
  type DesktopWindowTarget
} from '../shared/desktop-control'
import { MacComputerUseBridge } from './desktop-control-native'

export type DesktopAccessibilityDeps = {
  platform: string
  bridge: MacComputerUseBridge
  appBundlePath: string
  openExternal: (url: string) => Promise<void>
}

export function accessibilityGrantMessage(appBundlePath: string): string {
  return `当前运行的 Pi Desktop 尚未通过辅助功能权限检查。请在「系统设置 → 隐私与安全性 → 辅助功能」中添加并开启这份应用：${appBundlePath}。若同名旧条目已开启，请移除旧条目后添加此路径，再完全退出并打开 Pi Desktop。`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export class DesktopAccessibility {
  private helperTrusted: boolean | null = null

  constructor(private readonly deps: DesktopAccessibilityDeps) {}

  readPermission(): DesktopControlPermission {
    const platformSupported = this.deps.platform === 'darwin'
    if (!platformSupported) {
      return desktopControlPermissionSchema.parse({
        platformSupported: false,
        mediaAccessStatus: 'unavailable',
        access: 'unsupported',
        canCapture: false,
        canOpenSettings: false
      })
    }

    const mediaAccessStatus =
      this.helperTrusted === true
        ? 'granted'
        : this.helperTrusted === false
          ? 'denied'
          : 'unavailable'
    const access = mapScreenRecordingAccess(this.deps.platform, mediaAccessStatus)
    return desktopControlPermissionSchema.parse({
      platformSupported: true,
      mediaAccessStatus,
      access,
      canCapture: access === 'granted',
      canOpenSettings: true
    })
  }

  async probePermission(prompt = false, signal?: AbortSignal): Promise<DesktopControlPermission> {
    if (this.deps.platform !== 'darwin') return this.readPermission()
    if (signal?.aborted) throw new Error('Computer Use 操作已停止')
    try {
      const raw = asRecord(
        await this.deps.bridge.call({ action: 'accessibility-permission', prompt }, signal)
      )
      if (raw?.ok !== true || typeof raw.trusted !== 'boolean') {
        throw new Error('Computer Use 原生助手返回了无效的权限状态。')
      }
      this.helperTrusted = raw.trusted
    } catch (error) {
      this.helperTrusted = null
      signal?.throwIfAborted()
      throw error
    }
    return this.readPermission()
  }

  async sessionUnlocked(signal?: AbortSignal): Promise<boolean> {
    if (this.deps.platform !== 'darwin') return false
    if (signal?.aborted) throw new Error('Computer Use 操作已停止')
    const raw = asRecord(await this.deps.bridge.call({ action: 'session-lock' }, signal))
    if (raw?.ok !== true || typeof raw.locked !== 'boolean') {
      throw new Error('Computer Use 原生助手返回了无效的锁屏状态。')
    }
    return !raw.locked
  }

  async foregroundWindow(signal?: AbortSignal): Promise<DesktopWindowTarget> {
    if (this.deps.platform !== 'darwin') throw new Error('目标窗口识别仅支持 macOS')
    signal?.throwIfAborted()
    const raw = asRecord(await this.deps.bridge.call({ action: 'foreground-window' }, signal))
    const parsed = desktopWindowTargetSchema.safeParse(raw?.target)
    if (raw?.ok !== true || !parsed.success) {
      throw new Error('无法唯一识别当前目标窗口，请将目标窗口置于前台后重试')
    }
    return parsed.data
  }

  async dump(
    signal?: AbortSignal
  ): Promise<Extract<DesktopControlResult, { type: 'accessibility-dump' }>> {
    let permission = await this.probePermission(false, signal)
    const sessionUnlocked = await this.sessionUnlocked(signal)

    if (!permission.platformSupported) {
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission,
        dump: null,
        probed: false,
        sessionUnlocked,
        message: '辅助功能探测仅在 macOS 上可用。'
      })
    }

    if (permission.access !== 'granted') {
      permission = await this.probePermission(true, signal)
      if (permission.access !== 'granted') {
        return desktopControlAccessibilityDumpResultSchema.parse({
          type: 'accessibility-dump',
          permission,
          dump: null,
          probed: true,
          sessionUnlocked,
          message: accessibilityGrantMessage(this.deps.appBundlePath)
        })
      }
    }

    try {
      const raw = asRecord(await this.deps.bridge.call({ action: 'ax-dump' }, signal))
      if (!raw || raw.ok !== true) {
        this.helperTrusted = raw?.error === 'accessibility-not-trusted' ? false : this.helperTrusted
        return desktopControlAccessibilityDumpResultSchema.parse({
          type: 'accessibility-dump',
          permission: this.readPermission(),
          dump: null,
          probed: true,
          sessionUnlocked,
          message:
            raw?.error === 'accessibility-not-trusted'
              ? '当前 Computer Use helper 未获得辅助功能权限。请重新授权当前安装的 Pi Desktop 后完全退出并打开。'
              : '无法读取前台应用的辅助功能树。'
        })
      }
      const parsed = axDumpSchema.safeParse({
        app: raw.app ?? '',
        bundleId: raw.bundleId ?? '',
        ...(raw.target ? { target: raw.target } : {}),
        windows: raw.windows ?? [],
        nodeCount: raw.nodeCount ?? 0,
        truncated: raw.truncated === true
      })
      if (!parsed.success) {
        return desktopControlAccessibilityDumpResultSchema.parse({
          type: 'accessibility-dump',
          permission: this.readPermission(),
          dump: null,
          probed: true,
          sessionUnlocked,
          message: '辅助功能树超出边界或格式无效。'
        })
      }
      this.helperTrusted = true
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission: this.readPermission(),
        dump: parsed.data,
        probed: true,
        sessionUnlocked,
        message: parsed.data.truncated
          ? '仅显示有界辅助功能树；更深节点已省略。'
          : parsed.data.nodeCount === 0
            ? '未发现可读取的窗口结构。'
            : undefined
      })
    } catch {
      if (signal?.aborted) throw new Error('Computer Use 操作已停止')
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission: this.readPermission(),
        dump: null,
        probed: true,
        sessionUnlocked,
        message: 'Native Computer Use helper 无法读取窗口结构。请完全退出 Pi Desktop 后重试。'
      })
    }
  }

  async openSettings(): Promise<Extract<DesktopControlResult, { type: 'open-settings' }>> {
    const permission = this.readPermission()
    if (!permission.canOpenSettings) {
      return desktopControlOpenSettingsResultSchema.parse({
        type: 'open-settings',
        permission,
        opened: false,
        message: '系统设置中的辅助功能页仅在 macOS 上可用。'
      })
    }
    for (const url of ACCESSIBILITY_SETTINGS_URLS) {
      try {
        await this.deps.openExternal(url)
        return desktopControlOpenSettingsResultSchema.parse({
          type: 'open-settings',
          permission,
          opened: true,
          url
        })
      } catch {
        continue
      }
    }
    return desktopControlOpenSettingsResultSchema.parse({
      type: 'open-settings',
      permission,
      opened: false,
      message: '无法打开系统设置。请到「隐私与安全性 → 辅助功能」手动授权。'
    })
  }
}
