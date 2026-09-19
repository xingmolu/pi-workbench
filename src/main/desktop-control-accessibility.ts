import {
  ACCESSIBILITY_SETTINGS_URLS,
  accessAfterCaptureProbe,
  axDumpSchema,
  desktopControlAccessibilityDumpResultSchema,
  desktopControlOpenSettingsResultSchema,
  desktopControlPermissionSchema,
  mapScreenRecordingAccess,
  type DesktopControlPermission,
  type DesktopControlResult
} from '../shared/desktop-control'
import { JXA_AX_DUMP, JXA_SESSION_LOCK, runJxa, type JxaExec } from './desktop-control-jxa'

export type DesktopAccessibilityDeps = {
  platform: string
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean
  runJxa?: typeof runJxa
  exec: JxaExec
  openExternal: (url: string) => Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export class DesktopAccessibility {
  constructor(private readonly deps: DesktopAccessibilityDeps) {}

  private invokeJxa(source: string, signal?: AbortSignal): Promise<unknown> {
    return (this.deps.runJxa ?? runJxa)(this.deps.exec, source, signal)
  }

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
    let trusted: boolean | null = null
    if (this.deps.isTrustedAccessibilityClient) {
      try {
        trusted = this.deps.isTrustedAccessibilityClient(false)
      } catch {
        trusted = null
      }
    }
    const mediaAccessStatus =
      trusted === true ? 'granted' : trusted === false ? 'not-determined' : 'unavailable'
    const access = mapScreenRecordingAccess(this.deps.platform, mediaAccessStatus)
    return desktopControlPermissionSchema.parse({
      platformSupported: true,
      mediaAccessStatus,
      access,
      canCapture: access !== 'restricted',
      canOpenSettings: true
    })
  }

  async sessionUnlocked(signal?: AbortSignal): Promise<boolean> {
    if (this.deps.platform !== 'darwin') return false
    if (signal?.aborted) throw new Error('桌面控制操作已停止')
    try {
      const raw = asRecord(await this.invokeJxa(JXA_SESSION_LOCK, signal))
      if (!raw || raw.ok !== true) return false
      return raw.locked !== true
    } catch {
      if (signal?.aborted) throw new Error('桌面控制操作已停止')
      return false
    }
  }

  async dump(
    signal?: AbortSignal
  ): Promise<Extract<DesktopControlResult, { type: 'accessibility-dump' }>> {
    const permission = this.readPermission()
    const sessionUnlocked = await this.sessionUnlocked(signal)
    if (!permission.canCapture) {
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission,
        dump: null,
        probed: false,
        sessionUnlocked,
        message: permission.platformSupported
          ? '辅助功能受系统策略限制，无法读取窗口结构。'
          : '辅助功能探测仅在 macOS 上可用。'
      })
    }
    try {
      const raw = asRecord(await this.invokeJxa(JXA_AX_DUMP, signal))
      if (!raw || raw.ok !== true) {
        return desktopControlAccessibilityDumpResultSchema.parse({
          type: 'accessibility-dump',
          permission: this.readPermission(),
          dump: null,
          probed: true,
          sessionUnlocked,
          message: '无法读取前台应用的辅助功能树。请确认已授权辅助功能后重试。'
        })
      }
      const parsed = axDumpSchema.safeParse({
        app: raw.app ?? '',
        bundleId: raw.bundleId ?? '',
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
      const nextPermission = accessAfterCaptureProbe(
        this.readPermission(),
        parsed.data.windows.length > 0 || parsed.data.nodeCount > 0
          ? [{ id: 'ax:1', name: parsed.data.app || 'app', type: 'window', thumbnailDataUrl: '' }]
          : []
      )
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission: nextPermission,
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
      if (signal?.aborted) throw new Error('桌面控制操作已停止')
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission: this.readPermission(),
        dump: null,
        probed: true,
        sessionUnlocked,
        message: '无法读取窗口结构，请确认已授权辅助功能后完全退出（Cmd+Q）再打开。'
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
