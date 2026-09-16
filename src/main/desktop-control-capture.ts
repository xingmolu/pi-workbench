import {
  accessAfterCaptureProbe,
  captureSourceSchema,
  captureSourceTypeFromId,
  desktopControlCommandSchema,
  desktopControlOpenSettingsResultSchema,
  desktopControlPermissionResultSchema,
  desktopControlPermissionSchema,
  desktopControlSourcesResultSchema,
  DESKTOP_CONTROL_LIMITS,
  mapScreenRecordingAccess,
  thumbnailDataUrlSchema,
  SCREEN_RECORDING_SETTINGS_URLS,
  type CaptureSource,
  type DesktopControlCommand,
  type DesktopControlPermission,
  type DesktopControlResult,
  type MediaAccessStatus
} from '../shared/desktop-control'

export type DesktopCapturerThumbnail = {
  isEmpty?: () => boolean
  getSize?: () => { width: number; height: number }
  resize?: (size: { width: number; height: number }) => DesktopCapturerThumbnail
  toDataURL: () => string
}

export type DesktopCapturerSourceInput = {
  id: string
  name: string
  thumbnail: DesktopCapturerThumbnail
}

export type DesktopCaptureDeps = {
  platform: string
  getMediaAccessStatus?: (mediaType: 'screen') => string
  getSources: (options: {
    types: Array<'screen' | 'window'>
    thumbnailSize: { width: number; height: number }
    fetchWindowIcons: boolean
  }) => Promise<readonly DesktopCapturerSourceInput[]>
  openExternal: (url: string) => Promise<void>
}

function boundText(value: string, max: number): string {
  return value.replaceAll('\0', '').slice(0, max)
}

function boundThumbnail(thumbnail: DesktopCapturerThumbnail): string {
  if (thumbnail.isEmpty?.()) return ''
  let image = thumbnail
  const size = thumbnail.getSize?.()
  if (
    size &&
    (size.width > DESKTOP_CONTROL_LIMITS.thumbnailWidth ||
      size.height > DESKTOP_CONTROL_LIMITS.thumbnailHeight) &&
    thumbnail.resize
  ) {
    image = thumbnail.resize({
      width: DESKTOP_CONTROL_LIMITS.thumbnailWidth,
      height: DESKTOP_CONTROL_LIMITS.thumbnailHeight
    })
  }
  try {
    let dataUrl = image.toDataURL()
    if (dataUrl.length > DESKTOP_CONTROL_LIMITS.maxThumbnailDataUrlLength && image.resize) {
      dataUrl = image
        .resize({
          width: DESKTOP_CONTROL_LIMITS.fallbackThumbnailWidth,
          height: DESKTOP_CONTROL_LIMITS.fallbackThumbnailHeight
        })
        .toDataURL()
    }
    if (dataUrl.length > DESKTOP_CONTROL_LIMITS.maxThumbnailDataUrlLength) return ''
    return thumbnailDataUrlSchema.safeParse(dataUrl).success ? dataUrl : ''
  } catch {
    return ''
  }
}

function toSource(input: DesktopCapturerSourceInput): CaptureSource | null {
  const id = boundText(input.id, DESKTOP_CONTROL_LIMITS.maxSourceIdLength)
  const name = boundText(input.name, DESKTOP_CONTROL_LIMITS.maxNameLength) || '未命名窗口'
  const parsed = captureSourceSchema.safeParse({
    id,
    name,
    type: captureSourceTypeFromId(id),
    thumbnailDataUrl: boundThumbnail(input.thumbnail)
  })
  return parsed.success ? parsed.data : null
}

/**
 * macOS screen-capture foundation. Privileged Electron APIs stay in Main;
 * other platforms report unsupported and never call desktopCapturer.
 */
export class DesktopCapture {
  constructor(private readonly deps: DesktopCaptureDeps) {}

  readPermission(): DesktopControlPermission {
    const platformSupported = this.deps.platform === 'darwin'
    let mediaAccessStatus: MediaAccessStatus = 'unavailable'
    if (platformSupported && this.deps.getMediaAccessStatus) {
      try {
        const status = this.deps.getMediaAccessStatus('screen')
        mediaAccessStatus =
          status === 'not-determined' ||
          status === 'granted' ||
          status === 'denied' ||
          status === 'restricted' ||
          status === 'unknown'
            ? status
            : 'unknown'
      } catch {
        mediaAccessStatus = 'unavailable'
      }
    }
    const access = mapScreenRecordingAccess(this.deps.platform, mediaAccessStatus)
    return desktopControlPermissionSchema.parse({
      platformSupported,
      mediaAccessStatus,
      access,
      canCapture: platformSupported && access !== 'restricted',
      canOpenSettings: platformSupported
    })
  }

  async listSources(): Promise<Extract<DesktopControlResult, { type: 'sources' }>> {
    const permission = this.readPermission()
    if (!permission.canCapture) {
      return desktopControlSourcesResultSchema.parse({
        type: 'sources',
        permission,
        sources: [],
        truncated: false,
        probed: false,
        message: permission.platformSupported
          ? '屏幕录制受系统策略限制，无法列出屏幕或窗口。'
          : '桌面截取探测仅在 macOS 上可用。'
      })
    }
    try {
      const raw = await this.deps.getSources({
        types: ['screen', 'window'],
        thumbnailSize: {
          width: DESKTOP_CONTROL_LIMITS.thumbnailWidth,
          height: DESKTOP_CONTROL_LIMITS.thumbnailHeight
        },
        fetchWindowIcons: false
      })
      const mapped = raw
        .map((source) => toSource(source))
        .filter((source): source is CaptureSource => source !== null)
      mapped.sort((left, right) => {
        if (left.type === right.type) return left.name.localeCompare(right.name, 'en')
        return left.type === 'screen' ? -1 : 1
      })
      const sources = mapped.slice(0, DESKTOP_CONTROL_LIMITS.maxSources)
      const truncated = mapped.length > sources.length
      const nextPermission = accessAfterCaptureProbe(this.readPermission(), sources)
      return desktopControlSourcesResultSchema.parse({
        type: 'sources',
        permission: nextPermission,
        sources,
        truncated,
        probed: true,
        message:
          sources.length === 0
            ? nextPermission.access === 'denied'
              ? '尚未授权屏幕录制，无法列出屏幕或窗口。'
              : '未发现可截取的屏幕或窗口。'
            : truncated
              ? `仅显示前 ${DESKTOP_CONTROL_LIMITS.maxSources} 个来源。`
              : undefined
      })
    } catch {
      return desktopControlSourcesResultSchema.parse({
        type: 'sources',
        permission: this.readPermission(),
        sources: [],
        truncated: false,
        probed: true,
        message: '无法读取屏幕或窗口，请确认已授权屏幕录制后重试。'
      })
    }
  }

  async openScreenRecordingSettings(): Promise<
    Extract<DesktopControlResult, { type: 'open-settings' }>
  > {
    const permission = this.readPermission()
    if (!permission.canOpenSettings) {
      return desktopControlOpenSettingsResultSchema.parse({
        type: 'open-settings',
        permission,
        opened: false,
        message: '系统设置中的屏幕录制页仅在 macOS 上可用。'
      })
    }
    for (const url of SCREEN_RECORDING_SETTINGS_URLS) {
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
      message: '无法打开系统设置。请到「隐私与安全性 → 屏幕与系统录音」手动授权。'
    })
  }

  async dispatch(command: unknown): Promise<DesktopControlResult> {
    const request: DesktopControlCommand = desktopControlCommandSchema.parse(command)
    if (request.type === 'permission') {
      return desktopControlPermissionResultSchema.parse({
        type: 'permission',
        permission: this.readPermission()
      })
    }
    if (request.type === 'open-screen-recording-settings') {
      return this.openScreenRecordingSettings()
    }
    return this.listSources()
  }
}
