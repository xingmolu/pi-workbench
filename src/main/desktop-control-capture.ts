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
  type DesktopWindowTarget,
  type MediaAccessStatus
} from '../shared/desktop-control'
import {
  COMPUTER_USE_LIMITS,
  computerUseVisualFrameSchema,
  type ComputerUseFrameRect,
  type ComputerUseVisualFrame
} from '../shared/computer-use'

export type DesktopCapturerThumbnail = {
  isEmpty?: () => boolean
  getSize?: () => { width: number; height: number }
  resize?: (size: { width: number; height: number }) => DesktopCapturerThumbnail
  toDataURL: () => string
  toPNG?: () => Buffer
}

export type DesktopDisplayMetrics = {
  id: string
  bounds: ComputerUseFrameRect
  scaleFactor: number
  primary: boolean
}

export type DesktopCapturerSourceInput = {
  id: string
  name: string
  display_id?: string
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
  getDisplays?: () => readonly DesktopDisplayMetrics[]
  openExternal: (url: string) => Promise<void>
}

export class TargetCaptureError extends Error {}

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

function overlapArea(left: ComputerUseFrameRect, right: ComputerUseFrameRect): number {
  const x = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  )
  const y = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  )
  return x * y
}

function chooseDisplay(
  displays: readonly DesktopDisplayMetrics[],
  preferredBounds?: ComputerUseFrameRect
): DesktopDisplayMetrics | null {
  if (!displays.length) return null
  if (preferredBounds) {
    const ranked = displays
      .map((display) => ({ display, area: overlapArea(display.bounds, preferredBounds) }))
      .sort((left, right) => right.area - left.area)
    if (ranked[0]?.area) return ranked[0].display
  }
  return displays.find((display) => display.primary) ?? displays[0] ?? null
}

function targetImageSize(bounds: ComputerUseFrameRect): { width: number; height: number } {
  const largest = Math.max(bounds.width, bounds.height)
  const scale = Math.min(1, COMPUTER_USE_LIMITS.maxImageDimension / largest)
  return {
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  }
}

function pngBase64(image: DesktopCapturerThumbnail): string {
  if (image.toPNG) return image.toPNG().toString('base64')
  const dataUrl = image.toDataURL()
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!match) throw new Error('桌面截图不是 PNG')
  return match[1]
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

  readDisplays(): readonly DesktopDisplayMetrics[] {
    if (this.deps.platform !== 'darwin' || !this.deps.getDisplays) return []
    try {
      return this.deps
        .getDisplays()
        .filter(
          (display) =>
            display.id &&
            display.bounds.width > 0 &&
            display.bounds.height > 0 &&
            Number.isFinite(display.scaleFactor) &&
            display.scaleFactor > 0
        )
    } catch {
      return []
    }
  }

  async captureVisualFrame(
    target: DesktopWindowTarget,
    signal?: AbortSignal
  ): Promise<ComputerUseVisualFrame> {
    if (signal?.aborted) throw new Error('Computer Use 操作已停止')
    const permission = this.readPermission()
    if (!permission.platformSupported) throw new Error('视觉 Computer Use 当前仅支持 macOS')
    if (!permission.canCapture) throw new Error('屏幕录制受系统策略限制，无法读取桌面图像')

    const display = chooseDisplay(this.readDisplays(), target.frame)
    if (!display || overlapArea(display.bounds, target.frame) <= 0) {
      if (permission.access !== 'granted') throw new Error('屏幕录制不可用，请确认授权后重试')
      throw new TargetCaptureError('目标窗口不在可用显示器内')
    }
    const requestedSize = targetImageSize(target.frame)

    const sources = await this.deps.getSources({
      types: ['window'],
      thumbnailSize: requestedSize,
      fetchWindowIcons: false
    })
    if (signal?.aborted) throw new Error('Computer Use 操作已停止')

    const matched = sources.filter((source) => {
      const match = /^window:(\d+):\d+$/.exec(source.id)
      return match && Number(match[1]) === target.windowId
    })
    if (matched.length !== 1) {
      if (sources.length === 0 && permission.access !== 'granted') {
        throw new Error('屏幕录制尚未返回窗口图像，请确认授权后重试')
      }
      throw new TargetCaptureError('无法唯一匹配目标窗口截图，请重新 observe')
    }
    const source = matched[0]
    if (source.thumbnail.isEmpty?.()) {
      throw new Error('屏幕录制未返回目标窗口图像，请确认授权后重试')
    }

    let image = source.thumbnail
    const initial = image.getSize?.()
    if (!initial || initial.width <= 0 || initial.height <= 0) {
      throw new Error('目标窗口截图尺寸无效')
    }
    if (
      Math.max(initial.width, initial.height) > COMPUTER_USE_LIMITS.maxImageDimension &&
      image.resize
    ) {
      const scale = COMPUTER_USE_LIMITS.maxImageDimension / Math.max(initial.width, initial.height)
      image = image.resize({
        width: Math.max(1, Math.round(initial.width * scale)),
        height: Math.max(1, Math.round(initial.height * scale))
      })
    }
    const size = image.getSize?.() ?? initial
    const frameRatio = target.frame.width / target.frame.height
    const imageRatio = size.width / size.height
    if (Math.abs(frameRatio / imageRatio - 1) > 0.03) {
      throw new TargetCaptureError('窗口截图与目标窗口尺寸不一致，请重新 observe')
    }
    const data = pngBase64(image)
    if (!data || data.length > COMPUTER_USE_LIMITS.maxImageDataLength) {
      throw new Error('桌面截图超过 Computer Use 图像上限')
    }

    return computerUseVisualFrameSchema.parse({
      scope: 'window',
      sourceId: source.id,
      displayId: display.id,
      framePoints: target.frame,
      scaleFactor: display.scaleFactor,
      capturedAt: Date.now(),
      image: {
        mimeType: 'image/png',
        data,
        width: size.width,
        height: size.height
      }
    })
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
    if (request.type === 'sources') {
      return this.listSources()
    }
    throw new Error('桌面截取不处理该命令')
  }
}
