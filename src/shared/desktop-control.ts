import { z } from 'zod'

export const DESKTOP_CONTROL_CHANNEL = 'pi:desktop-control'

export const DESKTOP_CONTROL_LIMITS = {
  thumbnailWidth: 160,
  thumbnailHeight: 90,
  fallbackThumbnailWidth: 80,
  fallbackThumbnailHeight: 45,
  maxSources: 16,
  maxNameLength: 180,
  maxSourceIdLength: 256,
  maxThumbnailDataUrlLength: 80_000,
  maxMessageLength: 400
} as const

/**
 * Screen Recording privacy pane.
 *
 * Sequoia still accepts the long-standing Security pane deep link
 * (`Privacy_ScreenCapture`). The PrivacySecurity.extension URL opens the
 * Sequoia Settings host and is used as a fallback if the first open fails.
 */
export const SCREEN_RECORDING_SETTINGS_URLS = [
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture'
] as const

export const mediaAccessStatusSchema = z.enum([
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
  'unavailable'
])
export type MediaAccessStatus = z.infer<typeof mediaAccessStatusSchema>

export const screenRecordingAccessSchema = z.enum([
  'granted',
  'denied',
  'restricted',
  'unsupported'
])
export type ScreenRecordingAccess = z.infer<typeof screenRecordingAccessSchema>

export const SCREEN_RECORDING_CHIP_LABELS = {
  granted: '已授权',
  denied: '未授权',
  restricted: '受限',
  unsupported: '不支持'
} as const

export function mapScreenRecordingAccess(
  platform: string,
  mediaAccessStatus: string
): ScreenRecordingAccess {
  if (platform !== 'darwin') return 'unsupported'
  if (mediaAccessStatus === 'granted') return 'granted'
  if (mediaAccessStatus === 'restricted') return 'restricted'
  if (mediaAccessStatus === 'denied' || mediaAccessStatus === 'not-determined') return 'denied'
  return 'unsupported'
}

export function screenRecordingChipLabel(access: ScreenRecordingAccess): string {
  return SCREEN_RECORDING_CHIP_LABELS[access]
}

export const thumbnailDataUrlSchema = z
  .string()
  .max(DESKTOP_CONTROL_LIMITS.maxThumbnailDataUrlLength)
  .refine(
    (value) => value === '' || /^data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/.test(value)
  )

export const captureSourceTypeSchema = z.enum(['screen', 'window'])
export const captureSourceSchema = z
  .object({
    id: z.string().min(1).max(DESKTOP_CONTROL_LIMITS.maxSourceIdLength),
    name: z.string().min(1).max(DESKTOP_CONTROL_LIMITS.maxNameLength),
    type: captureSourceTypeSchema,
    thumbnailDataUrl: thumbnailDataUrlSchema
  })
  .strict()
export type CaptureSource = z.infer<typeof captureSourceSchema>

export const desktopControlPermissionSchema = z
  .object({
    platformSupported: z.boolean(),
    mediaAccessStatus: mediaAccessStatusSchema,
    access: screenRecordingAccessSchema,
    canCapture: z.boolean(),
    canOpenSettings: z.boolean()
  })
  .strict()
export type DesktopControlPermission = z.infer<typeof desktopControlPermissionSchema>

export const desktopControlCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('permission') }).strict(),
  z.object({ type: z.literal('sources') }).strict(),
  z.object({ type: z.literal('open-screen-recording-settings') }).strict()
])
export type DesktopControlCommand = z.infer<typeof desktopControlCommandSchema>

const messageSchema = z.string().max(DESKTOP_CONTROL_LIMITS.maxMessageLength)

export const desktopControlPermissionResultSchema = z
  .object({
    type: z.literal('permission'),
    permission: desktopControlPermissionSchema
  })
  .strict()
export const desktopControlSourcesResultSchema = z
  .object({
    type: z.literal('sources'),
    permission: desktopControlPermissionSchema,
    sources: z.array(captureSourceSchema).max(DESKTOP_CONTROL_LIMITS.maxSources),
    truncated: z.boolean(),
    probed: z.boolean(),
    message: messageSchema.optional()
  })
  .strict()
export const desktopControlOpenSettingsResultSchema = z
  .object({
    type: z.literal('open-settings'),
    permission: desktopControlPermissionSchema,
    opened: z.boolean(),
    url: z.string().max(300).optional(),
    message: messageSchema.optional()
  })
  .strict()
export const desktopControlResultSchema = z.discriminatedUnion('type', [
  desktopControlPermissionResultSchema,
  desktopControlSourcesResultSchema,
  desktopControlOpenSettingsResultSchema
])
export type DesktopControlResult = z.infer<typeof desktopControlResultSchema>

export function captureSourceTypeFromId(id: string): 'screen' | 'window' {
  return id.startsWith('screen:') ? 'screen' : 'window'
}
