import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  DEVICE_NAME_MAX,
  MAX_PAIRED_DEVICES,
  PAIRING_ALPHABET,
  PAIRING_TOKEN_LENGTH,
  PAIRING_TTL_MS,
  publicDevice,
  sanitizeDeviceName,
  type PairedDevicePublic,
  type PairedDeviceRecord
} from '../shared/mobile-gateway'
import { t } from '../shared/i18n'

export type PairingOffer = {
  token: string
  expiresAt: number
}

export type PairingGrant = {
  deviceId: string
  deviceToken: string
  device: PairedDevicePublic
}

type PairingStoreOptions = {
  now?: () => number
  random?: (size: number) => Uint8Array
  load: () => PairedDeviceRecord[]
  save: (devices: PairedDeviceRecord[]) => void
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function equalHash(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function parseDeviceToken(value: string): { deviceId: string; secret: string } | null {
  const split = value.indexOf('.')
  if (split <= 0 || split === value.length - 1) return null
  const deviceId = value.slice(0, split)
  const secret = value.slice(split + 1)
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || !/^[0-9a-f]{64}$/.test(secret)) return null
  return { deviceId, secret }
}

/** Wrong codes accepted against one offer before it is withdrawn. */
export const MAX_PAIRING_FAILURES = 10

export class MobilePairingStore {
  private offer: PairingOffer | null = null
  private failures = 0
  constructor(private readonly options: PairingStoreOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private bytes(size: number): Uint8Array {
    return this.options.random?.(size) ?? randomBytes(size)
  }

  list(): PairedDevicePublic[] {
    return this.options.load().map(publicDevice)
  }

  createOffer(): PairingOffer {
    const token = [...this.bytes(PAIRING_TOKEN_LENGTH)]
      .map((value) => PAIRING_ALPHABET[value! % PAIRING_ALPHABET.length]!)
      .join('')
    this.offer = { token, expiresAt: this.now() + PAIRING_TTL_MS }
    this.failures = 0
    return { ...this.offer }
  }

  currentOffer(): PairingOffer | null {
    if (!this.offer || this.offer.expiresAt <= this.now()) {
      this.offer = null
      return null
    }
    return { ...this.offer }
  }

  clearOffer(): void {
    this.offer = null
  }

  pair(token: string, deviceName: string): PairingGrant {
    const offer = this.currentOffer()
    if (!offer || !equalToken(token, offer.token)) {
      // Guessing is bounded per code: after a few misses the desktop has to show a new one.
      if (offer && ++this.failures >= MAX_PAIRING_FAILURES) this.offer = null
      throw new Error(t('配对码无效或已过期'))
    }
    const devices = this.options.load()
    if (devices.length >= MAX_PAIRED_DEVICES)
      throw new Error(t('已达到配对设备上限，请先在桌面撤销一台设备'))
    const secret = toHex(this.bytes(32))
    const deviceId = randomUUID()
    const record: PairedDeviceRecord = {
      deviceId,
      name: sanitizeDeviceName(deviceName).slice(0, DEVICE_NAME_MAX),
      tokenHash: hashSecret(secret),
      createdAt: this.now(),
      lastSeenAt: this.now()
    }
    this.options.save([...devices, record])
    this.offer = null
    return {
      deviceId,
      deviceToken: `${deviceId}.${secret}`,
      device: publicDevice(record)
    }
  }

  authenticate(deviceToken: string): PairedDevicePublic | null {
    const parsed = parseDeviceToken(deviceToken)
    if (!parsed) return null
    const devices = this.options.load()
    const index = devices.findIndex((device) => device.deviceId === parsed.deviceId)
    if (index < 0) return null
    const record = devices[index]!
    if (!equalHash(record.tokenHash, hashSecret(parsed.secret))) return null
    record.lastSeenAt = this.now()
    return publicDevice(record)
  }

  revoke(deviceId: string): boolean {
    const devices = this.options.load()
    const next = devices.filter((device) => device.deviceId !== deviceId)
    if (next.length === devices.length) return false
    this.options.save(next)
    return true
  }
}
