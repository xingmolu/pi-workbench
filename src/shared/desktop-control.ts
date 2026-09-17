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

export const DESKTOP_CONTROL_AX_LIMITS = {
  maxDepth: 6,
  maxNodes: 80,
  maxWindows: 4,
  maxChildren: 24,
  maxTextLength: 80,
  maxTypeLength: 200
} as const

export const DESKTOP_CONTROL_READ_ACTIONS = ['dump', 'hit_test'] as const
export const DESKTOP_CONTROL_INPUT_ACTIONS = ['click', 'move', 'type'] as const

export function desktopControlActionRequiresAsk(action: string): boolean {
  return (DESKTOP_CONTROL_INPUT_ACTIONS as readonly string[]).includes(action)
}

export function desktopControlGateMessage(input: {
  platformSupported: boolean
  sessionUnlocked: boolean
  screenGranted: boolean
  accessibilityGranted: boolean
}): string | null {
  if (!input.platformSupported) return '桌面控制仅在 macOS 上可用。'
  if (!input.sessionUnlocked) return '锁屏或锁定会话中拒绝桌面控制。请解锁后再试。'
  if (!input.screenGranted) return '尚未确认屏幕录制授权，拒绝桌面控制。'
  if (!input.accessibilityGranted) return '尚未确认辅助功能授权，拒绝桌面控制。'
  return null
}

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

export const ACCESSIBILITY_SETTINGS_URLS = [
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility'
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
  'pending',
  'unsupported'
])
export type ScreenRecordingAccess = z.infer<typeof screenRecordingAccessSchema>

export const SCREEN_RECORDING_CHIP_LABELS = {
  granted: '已授权',
  denied: '未授权',
  restricted: '受限',
  pending: '待确认',
  unsupported: '不支持'
} as const

export function mapScreenRecordingAccess(
  platform: string,
  mediaAccessStatus: string
): ScreenRecordingAccess {
  if (platform !== 'darwin') return 'unsupported'
  if (mediaAccessStatus === 'granted') return 'granted'
  if (mediaAccessStatus === 'restricted') return 'restricted'
  if (mediaAccessStatus === 'denied') return 'denied'
  // not-determined / unknown / unavailable are not 未授权; probe getSources first.
  return 'pending'
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

/** Sequoia+ can report denied while ScreenCaptureKit still returns real sources. */
export function accessAfterCaptureProbe(
  permission: DesktopControlPermission,
  sources: readonly CaptureSource[]
): DesktopControlPermission {
  if (sources.length === 0) return permission
  return {
    ...permission,
    access: 'granted',
    canCapture: true
  }
}

const coordSchema = z.number().int().min(-100_000).max(100_000)
const clickButtonSchema = z.enum(['left', 'right'])

export type AxNode = {
  role: string
  title: string
  value: string
  description: string
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  children: AxNode[]
}

export const axNodeSchema: z.ZodType<AxNode> = z.lazy(() =>
  z
    .object({
      role: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
      title: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
      value: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
      description: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
      x: z.number().finite().nullable(),
      y: z.number().finite().nullable(),
      width: z.number().finite().nullable(),
      height: z.number().finite().nullable(),
      children: z.array(axNodeSchema).max(DESKTOP_CONTROL_AX_LIMITS.maxChildren)
    })
    .strict()
)

export const axDumpSchema = z
  .object({
    app: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
    bundleId: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
    windows: z.array(axNodeSchema).max(DESKTOP_CONTROL_AX_LIMITS.maxWindows),
    nodeCount: z.number().int().nonnegative().max(DESKTOP_CONTROL_AX_LIMITS.maxNodes),
    truncated: z.boolean()
  })
  .strict()
export type AxDump = z.infer<typeof axDumpSchema>

export const axHitTargetSchema = z
  .object({
    role: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
    title: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
    value: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
    x: z.number().finite().nullable(),
    y: z.number().finite().nullable(),
    width: z.number().finite().nullable(),
    height: z.number().finite().nullable()
  })
  .strict()
export type AxHitTarget = z.infer<typeof axHitTargetSchema>

export const desktopControlCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('permission') }).strict(),
  z.object({ type: z.literal('sources') }).strict(),
  z.object({ type: z.literal('open-screen-recording-settings') }).strict(),
  z.object({ type: z.literal('accessibility-permission') }).strict(),
  z.object({ type: z.literal('accessibility-dump') }).strict(),
  z.object({ type: z.literal('open-accessibility-settings') }).strict(),
  z.object({ type: z.literal('input-preview'), x: coordSchema, y: coordSchema }).strict(),
  z
    .object({
      type: z.literal('input-click'),
      x: coordSchema,
      y: coordSchema,
      button: clickButtonSchema.optional(),
      confirmed: z.literal(true)
    })
    .strict()
])
export type DesktopControlCommand = z.infer<typeof desktopControlCommandSchema>

const messageSchema = z.string().max(DESKTOP_CONTROL_LIMITS.maxMessageLength)

export const desktopControlAgentOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dump') }).strict(),
  z.object({ action: z.literal('hit_test'), x: coordSchema, y: coordSchema }).strict(),
  z
    .object({
      action: z.literal('click'),
      x: coordSchema,
      y: coordSchema,
      button: clickButtonSchema.optional()
    })
    .strict(),
  z.object({ action: z.literal('move'), x: coordSchema, y: coordSchema }).strict(),
  z
    .object({
      action: z.literal('type'),
      text: z.string().min(1).max(DESKTOP_CONTROL_AX_LIMITS.maxTypeLength)
    })
    .strict()
])
export type DesktopControlAgentOperation = z.infer<typeof desktopControlAgentOperationSchema>

export type DesktopControlAskDecision =
  | { kind: 'skip'; action: 'dump' | 'hit_test' }
  | { kind: 'ask'; action: 'click' | 'move' | 'type' }
  | { kind: 'block'; reason: string }

/** Agent-path Ask: dump/hit_test skip; click/move/type always Ask, even in open mode. */
export function desktopControlAskDecision(input: unknown): DesktopControlAskDecision {
  const parsed = desktopControlAgentOperationSchema.safeParse(input)
  if (!parsed.success) return { kind: 'block', reason: '无效的桌面控制操作' }
  if (
    parsed.data.action === 'click' ||
    parsed.data.action === 'move' ||
    parsed.data.action === 'type'
  ) {
    return { kind: 'ask', action: parsed.data.action }
  }
  return { kind: 'skip', action: parsed.data.action }
}

export const desktopControlAgentResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('dump'),
      dump: axDumpSchema,
      sessionUnlocked: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal('hit-test'),
      app: z.string().max(DESKTOP_CONTROL_AX_LIMITS.maxTextLength),
      target: axHitTargetSchema.nullable(),
      sessionUnlocked: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal('action'),
      action: z.enum(['click', 'move', 'type']),
      message: messageSchema,
      x: coordSchema.optional(),
      y: coordSchema.optional()
    })
    .strict()
])
export type DesktopControlAgentResult = z.infer<typeof desktopControlAgentResultSchema>

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
export const desktopControlAccessibilityPermissionResultSchema = z
  .object({
    type: z.literal('accessibility-permission'),
    permission: desktopControlPermissionSchema
  })
  .strict()
export const desktopControlAccessibilityDumpResultSchema = z
  .object({
    type: z.literal('accessibility-dump'),
    permission: desktopControlPermissionSchema,
    dump: axDumpSchema.nullable(),
    probed: z.boolean(),
    sessionUnlocked: z.boolean(),
    message: messageSchema.optional()
  })
  .strict()
export const desktopControlInputPreviewResultSchema = z
  .object({
    type: z.literal('input-preview'),
    screen: desktopControlPermissionSchema,
    accessibility: desktopControlPermissionSchema,
    sessionUnlocked: z.boolean(),
    allowed: z.boolean(),
    x: coordSchema,
    y: coordSchema,
    target: axHitTargetSchema.nullable(),
    message: messageSchema.optional()
  })
  .strict()
export const desktopControlInputClickResultSchema = z
  .object({
    type: z.literal('input-click'),
    executed: z.boolean(),
    screen: desktopControlPermissionSchema,
    accessibility: desktopControlPermissionSchema,
    sessionUnlocked: z.boolean(),
    x: coordSchema,
    y: coordSchema,
    target: axHitTargetSchema.nullable(),
    message: messageSchema.optional()
  })
  .strict()
export const desktopControlResultSchema = z.discriminatedUnion('type', [
  desktopControlPermissionResultSchema,
  desktopControlSourcesResultSchema,
  desktopControlOpenSettingsResultSchema,
  desktopControlAccessibilityPermissionResultSchema,
  desktopControlAccessibilityDumpResultSchema,
  desktopControlInputPreviewResultSchema,
  desktopControlInputClickResultSchema
])
export type DesktopControlResult = z.infer<typeof desktopControlResultSchema>

export function axNodeToHitTarget(node: AxNode): AxHitTarget {
  return {
    role: node.role,
    title: node.title,
    value: node.value,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height
  }
}

export function hitTestAxNodes(nodes: readonly AxNode[], x: number, y: number): AxNode | null {
  let best: AxNode | null = null
  let bestArea = Number.POSITIVE_INFINITY
  const visit = (node: AxNode): void => {
    if (
      node.x !== null &&
      node.y !== null &&
      node.width !== null &&
      node.height !== null &&
      x >= node.x &&
      y >= node.y &&
      x <= node.x + node.width &&
      y <= node.y + node.height
    ) {
      const area = Math.max(node.width, 0) * Math.max(node.height, 0)
      if (area < bestArea) {
        best = node
        bestArea = area
      }
    }
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return best
}

export function captureSourceTypeFromId(id: string): 'screen' | 'window' {
  return id.startsWith('screen:') ? 'screen' : 'window'
}
