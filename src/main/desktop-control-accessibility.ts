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
import { t } from '../shared/i18n'

export type DesktopAccessibilityDeps = {
  platform: string
  bridge: MacComputerUseBridge
  appBundlePath: string
  openExternal: (url: string) => Promise<void>
  /** Starts an app that is not running yet (macOS `open -a` / `open -b`). */
  launchApp?: (args: readonly string[], signal?: AbortSignal) => Promise<void>
}

export type ActivatedApp = { app: string; bundleId: string }
export type ListedApp = {
  pid: number
  name: string
  bundleId: string
  active: boolean
  hidden: boolean
  windows: number
}
export type ListedWindows = {
  pid: number
  app: string
  bundleId: string
  windows: {
    title: string
    focused: boolean
    minimized: boolean
    frame?: { x: number; y: number; width: number; height: number }
  }[]
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export function accessibilityGrantMessage(appBundlePath: string): string {
  return t(
    '当前运行的 Pi Desktop 尚未通过辅助功能权限检查。请在「系统设置 → 隐私与安全性 → 辅助功能」中添加并开启这份应用：{appBundlePath}。若同名旧条目已开启，请移除旧条目后添加此路径，再完全退出并打开 Pi Desktop。',
    { appBundlePath }
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validAppName(query: string): string {
  const app = query.trim()
  if (!app || app.length > 80 || app.startsWith('-') || /[\0/\n]/.test(app))
    throw new Error(t('应用名称无效'))
  return app
}

function throwAppLookup(raw: Record<string, unknown> | null, app: string): void {
  if (raw?.error === 'app-not-running') throw new Error(t('没有找到正在运行的「{app}」', { app }))
  if (raw?.error === 'app-ambiguous') {
    const candidates = Array.isArray(raw.candidates) ? raw.candidates.join('、') : ''
    throw new Error(
      t('「{app}」匹配到多个应用{value}，请使用完整名称', {
        app,
        value: candidates ? `：${candidates}` : ''
      })
    )
  }
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
    if (signal?.aborted) throw new Error(t('Computer Use 操作已停止'))
    try {
      const raw = asRecord(
        await this.deps.bridge.call({ action: 'accessibility-permission', prompt }, signal)
      )
      if (raw?.ok !== true || typeof raw.trusted !== 'boolean') {
        throw new Error(t('Computer Use 原生助手返回了无效的权限状态。'))
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
    if (signal?.aborted) throw new Error(t('Computer Use 操作已停止'))
    const raw = asRecord(await this.deps.bridge.call({ action: 'session-lock' }, signal))
    if (raw?.ok !== true || typeof raw.locked !== 'boolean') {
      throw new Error(t('Computer Use 原生助手返回了无效的锁屏状态。'))
    }
    return !raw.locked
  }

  async foregroundWindow(signal?: AbortSignal): Promise<DesktopWindowTarget> {
    if (this.deps.platform !== 'darwin') throw new Error(t('目标窗口识别仅支持 macOS'))
    signal?.throwIfAborted()
    const raw = asRecord(await this.deps.bridge.call({ action: 'foreground-window' }, signal))
    const parsed = desktopWindowTargetSchema.safeParse(raw?.target)
    if (raw?.ok !== true || !parsed.success) {
      throw new Error(t('无法唯一识别当前目标窗口，请将目标窗口置于前台后重试'))
    }
    return parsed.data
  }

  /** Best effort: the caller still verifies the foreground window before any input. */
  async activateTarget(target: DesktopWindowTarget, signal?: AbortSignal): Promise<boolean> {
    if (this.deps.platform !== 'darwin') return false
    const raw = asRecord(
      await this.deps.bridge.call({ action: 'activate-target', expectedTarget: target }, signal)
    )
    return raw?.ok === true && raw.front === true
  }

  /** Brings a running app forward, starting it first when it is not running. */
  async activateApp(query: string, signal?: AbortSignal): Promise<ActivatedApp> {
    if (this.deps.platform !== 'darwin') throw new Error(t('切换应用仅支持 macOS'))
    const app = query.trim()
    if (!app || app.length > 80 || app.startsWith('-') || /[\0/\n]/.test(app))
      throw new Error(t('应用名称无效'))
    const attempt = async (): Promise<Record<string, unknown> | null> =>
      asRecord(await this.deps.bridge.call({ action: 'activate-app', app }, signal))
    let raw = await attempt()
    if (raw?.error === 'app-not-running') {
      if (!this.deps.launchApp) throw new Error(t('没有找到正在运行的「{app}」', { app }))
      try {
        await this.deps.launchApp([BUNDLE_ID.test(app) ? '-b' : '-a', app], signal)
      } catch (error) {
        signal?.throwIfAborted()
        throw new Error(
          t('无法打开「{app}」：请确认应用名称（与「应用程序」文件夹中的名称一致）', { app }),
          {
            cause: error
          }
        )
      }
      // A launched app registers with the window server shortly after `open` returns.
      for (let tries = 0; tries < 10 && raw?.error === 'app-not-running'; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        signal?.throwIfAborted()
        raw = await attempt()
      }
    }
    if (raw?.error === 'app-ambiguous') {
      const candidates = Array.isArray(raw.candidates) ? raw.candidates.join('、') : ''
      throw new Error(
        t('「{app}」匹配到多个应用{value}，请使用完整名称', {
          app,
          value: candidates ? `：${candidates}` : ''
        })
      )
    }
    if (raw?.ok !== true) throw new Error(t('没有找到正在运行的「{app}」', { app }))
    return {
      app: typeof raw.app === 'string' ? raw.app : app,
      bundleId: typeof raw.bundleId === 'string' ? raw.bundleId : ''
    }
  }

  /** Regular apps with their window counts; Pi itself is left out by the helper. */
  async listApps(signal?: AbortSignal): Promise<ListedApp[]> {
    if (this.deps.platform !== 'darwin') throw new Error(t('列出应用仅支持 macOS'))
    const raw = asRecord(await this.deps.bridge.call({ action: 'list-apps' }, signal))
    if (raw?.ok !== true || !Array.isArray(raw.apps))
      throw new Error(t('Computer Use 原生助手返回了无效的应用列表。'))
    return raw.apps.flatMap((entry) => {
      const app = asRecord(entry)
      if (!app || typeof app.name !== 'string') return []
      return [
        {
          pid: typeof app.pid === 'number' ? app.pid : 0,
          name: app.name,
          bundleId: typeof app.bundleId === 'string' ? app.bundleId : '',
          active: app.active === true,
          hidden: app.hidden === true,
          windows: typeof app.windows === 'number' ? app.windows : 0
        }
      ]
    })
  }

  async listWindows(app: string, signal?: AbortSignal): Promise<ListedWindows> {
    if (this.deps.platform !== 'darwin') throw new Error(t('列出窗口仅支持 macOS'))
    const raw = asRecord(
      await this.deps.bridge.call({ action: 'list-windows', app: validAppName(app) }, signal)
    )
    throwAppLookup(raw, app)
    if (raw?.ok !== true || !Array.isArray(raw.windows))
      throw new Error(t('Computer Use 原生助手返回了无效的窗口列表。'))
    return {
      pid: typeof raw.pid === 'number' ? raw.pid : 0,
      app: typeof raw.app === 'string' ? raw.app : app,
      bundleId: typeof raw.bundleId === 'string' ? raw.bundleId : '',
      windows: raw.windows.flatMap((entry) => {
        const window = asRecord(entry)
        if (!window) return []
        const frame = asRecord(window.frame)
        return [
          {
            title: typeof window.title === 'string' ? window.title : '',
            focused: window.focused === true,
            minimized: window.minimized === true,
            ...(frame &&
            [frame.x, frame.y, frame.width, frame.height].every((item) => typeof item === 'number')
              ? {
                  frame: {
                    x: frame.x as number,
                    y: frame.y as number,
                    width: frame.width as number,
                    height: frame.height as number
                  }
                }
              : {})
          }
        ]
      })
    }
  }

  /** Raises one window of a running app, chosen by part of its title. */
  async activateWindow(app: string, window: string, signal?: AbortSignal): Promise<ActivatedApp> {
    if (this.deps.platform !== 'darwin') throw new Error(t('切换窗口仅支持 macOS'))
    const raw = asRecord(
      await this.deps.bridge.call(
        { action: 'activate-window', app: validAppName(app), window },
        signal
      )
    )
    throwAppLookup(raw, app)
    if (raw?.error === 'window-not-found')
      throw new Error(t('「{app}」没有标题包含「{window}」的窗口', { app, window }))
    if (raw?.error === 'window-ambiguous') {
      const candidates = Array.isArray(raw.candidates) ? raw.candidates.join('、') : ''
      throw new Error(
        t('「{window}」匹配到多个窗口{value}，请提供更完整的标题', {
          window,
          value: candidates ? `：${candidates}` : ''
        })
      )
    }
    if (raw?.ok !== true) throw new Error(t('无法切换到「{app}」的窗口', { app }))
    return {
      app: typeof raw.app === 'string' ? raw.app : app,
      bundleId: typeof raw.bundleId === 'string' ? raw.bundleId : ''
    }
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
        message: t('辅助功能探测仅在 macOS 上可用。')
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
              ? t(
                  '当前 Computer Use helper 未获得辅助功能权限。请重新授权当前安装的 Pi Desktop 后完全退出并打开。'
                )
              : t('无法读取前台应用的辅助功能树。')
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
          message: t('辅助功能树超出边界或格式无效。')
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
          ? t('仅显示有界辅助功能树；更深节点已省略。')
          : parsed.data.nodeCount === 0
            ? t('未发现可读取的窗口结构。')
            : undefined
      })
    } catch {
      if (signal?.aborted) throw new Error(t('Computer Use 操作已停止'))
      return desktopControlAccessibilityDumpResultSchema.parse({
        type: 'accessibility-dump',
        permission: this.readPermission(),
        dump: null,
        probed: true,
        sessionUnlocked,
        message: t('Native Computer Use helper 无法读取窗口结构。请完全退出 Pi Desktop 后重试。')
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
        message: t('系统设置中的辅助功能页仅在 macOS 上可用。')
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
      message: t('无法打开系统设置。请到「隐私与安全性 → 辅助功能」手动授权。')
    })
  }
}
