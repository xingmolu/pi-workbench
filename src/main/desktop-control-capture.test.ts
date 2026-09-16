import { describe, expect, it, vi } from 'vitest'
import { DesktopCapture, type DesktopCapturerSourceInput } from './desktop-control-capture'
import { DESKTOP_CONTROL_LIMITS, SCREEN_RECORDING_SETTINGS_URLS } from '../shared/desktop-control'

const PNG = 'data:image/png;base64,AAAA'

function source(
  id: string,
  name: string,
  thumbnailDataUrl = PNG,
  extras: Partial<DesktopCapturerSourceInput['thumbnail']> = {}
): DesktopCapturerSourceInput {
  return {
    id,
    name,
    thumbnail: {
      isEmpty: () => thumbnailDataUrl === '',
      getSize: () => ({
        width: DESKTOP_CONTROL_LIMITS.thumbnailWidth,
        height: DESKTOP_CONTROL_LIMITS.thumbnailHeight
      }),
      toDataURL: () => thumbnailDataUrl,
      ...extras
    }
  }
}

function capture(options: {
  platform?: string
  status?: string
  sources?: DesktopCapturerSourceInput[]
  getSources?: () => Promise<DesktopCapturerSourceInput[]>
  openExternal?: (url: string) => Promise<void>
}): {
  getSources: ReturnType<typeof vi.fn>
  getMediaAccessStatus: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  api: DesktopCapture
} {
  const getSources = options.getSources
    ? vi.fn(options.getSources)
    : vi.fn(async () => options.sources ?? [])
  const getMediaAccessStatus = vi.fn(() => options.status ?? 'granted')
  const openExternal = vi.fn(options.openExternal ?? (async () => undefined))
  return {
    getSources,
    getMediaAccessStatus,
    openExternal,
    api: new DesktopCapture({
      platform: options.platform ?? 'darwin',
      getMediaAccessStatus,
      getSources,
      openExternal
    })
  }
}

describe('DesktopCapture', () => {
  it('reports unsupported on non-macOS and does not touch capturer or settings', async () => {
    const { api, getSources, getMediaAccessStatus, openExternal } = capture({
      platform: 'linux',
      status: 'granted'
    })
    const permission = await api.dispatch({ type: 'permission' })
    expect(permission).toMatchObject({
      type: 'permission',
      permission: {
        platformSupported: false,
        access: 'unsupported',
        canCapture: false,
        canOpenSettings: false,
        mediaAccessStatus: 'unavailable'
      }
    })
    expect(getMediaAccessStatus).not.toHaveBeenCalled()
    const sources = await api.dispatch({ type: 'sources' })
    expect(sources).toMatchObject({
      type: 'sources',
      probed: false,
      sources: [],
      message: '桌面截取探测仅在 macOS 上可用。'
    })
    expect(getSources).not.toHaveBeenCalled()
    const settings = await api.dispatch({ type: 'open-screen-recording-settings' })
    expect(settings).toMatchObject({ type: 'open-settings', opened: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('maps denied and restricted without listing sources', async () => {
    const denied = capture({ status: 'denied' })
    expect(await denied.api.dispatch({ type: 'sources' })).toMatchObject({
      permission: { access: 'denied', canCapture: false },
      probed: false,
      message: '尚未授权屏幕录制，无法列出屏幕或窗口。'
    })
    expect(denied.getSources).not.toHaveBeenCalled()
    const restricted = capture({ status: 'restricted' })
    expect(await restricted.api.dispatch({ type: 'sources' })).toMatchObject({
      permission: { access: 'restricted' },
      probed: false,
      message: '屏幕录制受系统策略限制，无法列出屏幕或窗口。'
    })
    expect(restricted.getSources).not.toHaveBeenCalled()
  })

  it('lists bounded screen and window thumbnails when granted', async () => {
    const oversized = `data:image/png;base64,${'A'.repeat(DESKTOP_CONTROL_LIMITS.maxThumbnailDataUrlLength)}`
    const { api, getSources } = capture({
      sources: [
        source('window:2:0', 'Code'),
        source('screen:0:0', 'Built-in Retina Display'),
        source('window:1:0', 'Finder', oversized, {
          resize: () => ({
            toDataURL: () => PNG,
            resize: () => ({ toDataURL: () => PNG })
          })
        }),
        source('window:3:0', '', 'javascript:alert(1)')
      ]
    })
    const result = await api.dispatch({ type: 'sources' })
    expect(getSources).toHaveBeenCalledExactlyOnceWith({
      types: ['screen', 'window'],
      thumbnailSize: {
        width: DESKTOP_CONTROL_LIMITS.thumbnailWidth,
        height: DESKTOP_CONTROL_LIMITS.thumbnailHeight
      },
      fetchWindowIcons: false
    })
    expect(result).toMatchObject({ type: 'sources', probed: true, truncated: false })
    if (result.type !== 'sources') throw new Error('expected sources')
    expect(result.sources.map((item) => item.id)).toEqual([
      'screen:0:0',
      'window:2:0',
      'window:1:0',
      'window:3:0'
    ])
    expect(result.sources[0]).toMatchObject({ type: 'screen', thumbnailDataUrl: PNG })
    expect(result.sources[2]?.thumbnailDataUrl).toBe(PNG)
    expect(result.sources[3]).toMatchObject({ name: '未命名窗口', thumbnailDataUrl: '' })
  })

  it('probes not-determined sources and truncates the gallery', async () => {
    const sources = Array.from({ length: DESKTOP_CONTROL_LIMITS.maxSources + 3 }, (_, index) =>
      source(`window:${index}:0`, `Window ${index}`)
    )
    const { api, getSources } = capture({ status: 'not-determined', sources })
    const result = await api.dispatch({ type: 'sources' })
    expect(getSources).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      type: 'sources',
      probed: true,
      truncated: true,
      permission: { access: 'denied', canCapture: true, mediaAccessStatus: 'not-determined' },
      message: `仅显示前 ${DESKTOP_CONTROL_LIMITS.maxSources} 个来源。`
    })
    if (result.type !== 'sources') throw new Error('expected sources')
    expect(result.sources).toHaveLength(DESKTOP_CONTROL_LIMITS.maxSources)
  })

  it('opens the Sequoia-compatible privacy pane and falls back', async () => {
    const first = capture({
      openExternal: async (url) => {
        if (url === SCREEN_RECORDING_SETTINGS_URLS[0]) throw new Error('legacy missing')
      }
    })
    expect(await first.api.dispatch({ type: 'open-screen-recording-settings' })).toMatchObject({
      type: 'open-settings',
      opened: true,
      url: SCREEN_RECORDING_SETTINGS_URLS[1]
    })
    const failed = capture({
      openExternal: async () => {
        throw new Error('blocked')
      }
    })
    expect(await failed.api.dispatch({ type: 'open-screen-recording-settings' })).toMatchObject({
      opened: false,
      message: expect.stringContaining('隐私与安全性')
    })
  })

  it('treats media-status failures as unavailable without listing sources', async () => {
    const api = new DesktopCapture({
      platform: 'darwin',
      getMediaAccessStatus: () => {
        throw new Error('no TCC')
      },
      getSources: async () => {
        throw new Error('should not list')
      },
      openExternal: async () => undefined
    })
    expect(await api.dispatch({ type: 'permission' })).toMatchObject({
      permission: { mediaAccessStatus: 'unavailable', access: 'unsupported', canCapture: false }
    })
    expect(await api.dispatch({ type: 'sources' })).toMatchObject({ probed: false, sources: [] })
  })

  it('rejects unknown IPC commands', async () => {
    const { api } = capture({})
    await expect(api.dispatch({ type: 'click' })).rejects.toThrow()
  })
})
