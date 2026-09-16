import { describe, expect, it } from 'vitest'
import {
  captureSourceSchema,
  captureSourceTypeFromId,
  desktopControlCommandSchema,
  desktopControlResultSchema,
  mapScreenRecordingAccess,
  screenRecordingChipLabel,
  SCREEN_RECORDING_CHIP_LABELS,
  SCREEN_RECORDING_SETTINGS_URLS
} from './desktop-control'

const grantedPermission = {
  platformSupported: true,
  mediaAccessStatus: 'granted' as const,
  access: 'granted' as const,
  canCapture: true,
  canOpenSettings: true
}

describe('desktop control DTOs', () => {
  it.each([
    ['darwin', 'granted', 'granted'],
    ['darwin', 'denied', 'denied'],
    ['darwin', 'not-determined', 'denied'],
    ['darwin', 'restricted', 'restricted'],
    ['darwin', 'unknown', 'unsupported'],
    ['darwin', 'unavailable', 'unsupported'],
    ['linux', 'granted', 'unsupported'],
    ['win32', 'denied', 'unsupported']
  ] as const)('maps %s / %s to %s', (platform, status, access) => {
    expect(mapScreenRecordingAccess(platform, status)).toBe(access)
  })

  it('exposes the four settings chips', () => {
    expect(screenRecordingChipLabel('granted')).toBe('已授权')
    expect(screenRecordingChipLabel('denied')).toBe('未授权')
    expect(screenRecordingChipLabel('restricted')).toBe('受限')
    expect(screenRecordingChipLabel('unsupported')).toBe('不支持')
    expect(Object.values(SCREEN_RECORDING_CHIP_LABELS)).toEqual([
      '已授权',
      '未授权',
      '受限',
      '不支持'
    ])
  })

  it('accepts the three renderer commands and rejects extras', () => {
    expect(desktopControlCommandSchema.parse({ type: 'permission' }).type).toBe('permission')
    expect(desktopControlCommandSchema.parse({ type: 'sources' }).type).toBe('sources')
    expect(desktopControlCommandSchema.parse({ type: 'open-screen-recording-settings' }).type).toBe(
      'open-screen-recording-settings'
    )
    expect(desktopControlCommandSchema.safeParse({ type: 'permission', extra: true }).success).toBe(
      false
    )
    expect(desktopControlCommandSchema.safeParse({ type: 'click' }).success).toBe(false)
  })

  it('parses bounded capture sources and drops oversized thumbnails', () => {
    const source = {
      id: 'screen:0:0',
      name: 'Built-in Retina Display',
      type: 'screen',
      thumbnailDataUrl: 'data:image/png;base64,AAAA'
    }
    expect(captureSourceSchema.parse(source)).toEqual(source)
    expect(captureSourceTypeFromId('screen:1:0')).toBe('screen')
    expect(captureSourceTypeFromId('window:42:0')).toBe('window')
    expect(
      captureSourceSchema.safeParse({
        ...source,
        thumbnailDataUrl: `data:image/png;base64,${'A'.repeat(80_001)}`
      }).success
    ).toBe(false)
    expect(
      captureSourceSchema.safeParse({ ...source, thumbnailDataUrl: 'javascript:alert(1)' }).success
    ).toBe(false)
    expect(captureSourceSchema.safeParse({ ...source, extra: true }).success).toBe(false)
  })

  it('parses permission, sources, and open-settings results', () => {
    expect(
      desktopControlResultSchema.parse({ type: 'permission', permission: grantedPermission })
    ).toMatchObject({ type: 'permission' })
    expect(
      desktopControlResultSchema.parse({
        type: 'sources',
        permission: grantedPermission,
        sources: [
          {
            id: 'window:1:0',
            name: 'Finder',
            type: 'window',
            thumbnailDataUrl: ''
          }
        ],
        truncated: false,
        probed: true
      }).sources
    ).toHaveLength(1)
    expect(
      desktopControlResultSchema.parse({
        type: 'open-settings',
        permission: grantedPermission,
        opened: true,
        url: SCREEN_RECORDING_SETTINGS_URLS[0]
      }).opened
    ).toBe(true)
    expect(
      desktopControlResultSchema.safeParse({
        type: 'permission',
        permission: { ...grantedPermission, extra: 1 }
      }).success
    ).toBe(false)
  })
})
