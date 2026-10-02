import { z } from 'zod'
import type {
  ApprovalRequest,
  ConversationNode,
  PermissionMode,
  SessionStatus,
  ThinkingLevel
} from './contracts'
import type { CheckpointTurnState } from './checkpoints'
import type { LiveSessionSummary } from './session-runtime'
import { stripIsoTimestamp } from './mobile-list'
import { remoteViewAccessSchema, type RemoteViewAccess } from './remote-views'
import { t } from './i18n'

export const MOBILE_GATEWAY_CHANNEL = 'pi:mobile-gateway'
export const MOBILE_GATEWAY_PORT = 43124
export const MOBILE_GATEWAY_LOOPBACK = '127.0.0.1'
export const PAIRING_TTL_MS = 5 * 60 * 1000
export const MAX_PAIRED_DEVICES = 16
export const DEVICE_NAME_MAX = 64
export const PAIRING_TOKEN_LENGTH = 8
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const MOBILE_SECURITY_COPY = t('手机能用这台电脑上的工具改文件、跑命令。只扫你自己的码。')

export const MOBILE_KEEP_AWAKE_COPY = t('远程使用时请保持这台 Mac 唤醒；睡眠或断电后手机无法连接。')

export type PairedDeviceRecord = {
  deviceId: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
}

export type PairedDevicePublic = {
  deviceId: string
  name: string
  createdAt: number
  lastSeenAt: number
}

export type PairingOfferPublic = {
  token: string
  expiresAt: number
  url: string
  qrSvg: string
}

export type TailscaleGatewayStatus = {
  available: boolean
  online: boolean
  magicDns: string | null
  serveUrl: string | null
  binary: string | null
  error: string | null
}

export type MobileGatewayState = {
  running: boolean
  port: number | null
  loopbackUrl: string | null
  lanUrl: string | null
  lanAddress: string | null
  pairing: PairingOfferPublic | null
  devices: PairedDevicePublic[]
  powerSave: boolean
  tailscale: TailscaleGatewayStatus
  /** What paired phones may do with the desktop's browser and terminals. */
  remoteViews: RemoteViewAccess
  error: string | null
}

export const mobileGatewayCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }),
  z.strictObject({ type: z.literal('start') }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('pairing:create') }),
  /** Opens the phone UI in a phone-sized desktop window, paired as the preview device. */
  z.strictObject({ type: z.literal('preview:open') }),
  z.strictObject({
    type: z.literal('device:revoke'),
    deviceId: z.string().uuid()
  }),
  z.strictObject({ type: z.literal('tailscale:probe') }),
  z.strictObject({ type: z.literal('remote-views'), access: remoteViewAccessSchema }),
  z.strictObject({ type: z.literal('tailscale:serve') }),
  z.strictObject({ type: z.literal('tailscale:unserve') }),
  z.strictObject({
    type: z.literal('clipboard:copy'),
    text: z.string().min(1).max(2048)
  })
])
export type MobileGatewayCommand = z.infer<typeof mobileGatewayCommandSchema>

export const pairedDevicePublicSchema = z
  .object({
    deviceId: z.string().uuid(),
    name: z.string().min(1).max(DEVICE_NAME_MAX),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative()
  })
  .strict()

export const pairingOfferPublicSchema = z
  .object({
    token: z.string().min(PAIRING_TOKEN_LENGTH).max(PAIRING_TOKEN_LENGTH),
    expiresAt: z.number().int().nonnegative(),
    url: z.string().min(1).max(512),
    qrSvg: z.string().min(1).max(64_000)
  })
  .strict()

export const tailscaleGatewayStatusSchema = z
  .object({
    available: z.boolean(),
    online: z.boolean(),
    magicDns: z.string().min(1).max(256).nullable(),
    serveUrl: z.string().min(1).max(512).nullable(),
    binary: z.string().min(1).max(512).nullable(),
    error: z.string().max(500).nullable()
  })
  .strict()

export const mobileGatewayStateSchema: z.ZodType<MobileGatewayState> = z
  .object({
    running: z.boolean(),
    port: z.number().int().min(1).max(65535).nullable(),
    loopbackUrl: z.string().min(1).max(512).nullable(),
    lanUrl: z.string().min(1).max(512).nullable(),
    lanAddress: z.string().min(1).max(64).nullable(),
    pairing: pairingOfferPublicSchema.nullable(),
    devices: z.array(pairedDevicePublicSchema).max(MAX_PAIRED_DEVICES),
    powerSave: z.boolean(),
    tailscale: tailscaleGatewayStatusSchema,
    remoteViews: remoteViewAccessSchema,
    error: z.string().max(500).nullable()
  })
  .strict()

export const EMPTY_MOBILE_GATEWAY_STATE: MobileGatewayState = {
  running: false,
  port: null,
  loopbackUrl: null,
  lanUrl: null,
  lanAddress: null,
  pairing: null,
  devices: [],
  powerSave: false,
  remoteViews: 'off',
  tailscale: {
    available: false,
    online: false,
    magicDns: null,
    serveUrl: null,
    binary: null,
    error: null
  },
  error: null
}

export type MobileSessionListItem = {
  workerId: string
  cwd: string
  sessionPath: string | null
  sessionId: string | null
  generation: number | null
  status: SessionStatus | 'opening'
  selected: boolean
  title: string
}

export type MobileCatalogSession = {
  path: string
  title: string
  modified: string
  status: SessionStatus
}

export type MobileCatalogProject = {
  path: string
  name: string
  sessions: MobileCatalogSession[]
}

export type MobileConversationSnapshot = {
  workerId: string
  cwd: string
  /** Saved session file; lets the page reopen the session after its worker is gone. */
  sessionPath?: string | null
  title: string
  sessionId: string | null
  generation: number
  revision: number
  status: SessionStatus | 'opening'
  busy: boolean
  approvals: ApprovalRequest[]
  followUp: string[]
  queuedCount: number
  composeBlockReason: string | null
  model?: string | null
  /** Provider of `model`; with it, identifies the active model among `models`. */
  provider?: string | null
  models?: MobileModelOption[]
  permissionMode?: PermissionMode
  /** Reasoning effort of the active model; null when it does not reason. */
  thinking?: { level: ThinkingLevel; available: ThinkingLevel[] } | null
  /** Display names of the model providers, by id. */
  providers?: Record<string, string>
  checkpoints?: CheckpointTurnState[]
  error?: string
  nodes: ConversationNode[]
}

export type MobileModelOption = {
  provider: string
  id: string
  name: string
  image: boolean
  reasoning?: boolean
  contextWindow?: number
  unavailableReason?: string
}

export function publicDevice(record: PairedDeviceRecord): PairedDevicePublic {
  return {
    deviceId: record.deviceId,
    name: record.name,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt
  }
}

/** The preview window's user agent starts with this; it is also its device name. */
export const MOBILE_PREVIEW_AGENT = 'PiDesktopPreview'

export function isPreviewDevice(name: string): boolean {
  return name.startsWith(MOBILE_PREVIEW_AGENT)
}

export function sanitizeDeviceName(value: string, fallback = t('手机')): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.slice(0, DEVICE_NAME_MAX) || fallback
}

export function liveSessionToMobile(session: LiveSessionSummary): MobileSessionListItem {
  return {
    workerId: session.workerId,
    cwd: session.cwd,
    sessionPath: session.sessionPath,
    sessionId: session.sessionId,
    generation: session.generation,
    status: session.status,
    selected: session.selected,
    title: stripIsoTimestamp(session.title ?? t('新会话'))
  }
}
