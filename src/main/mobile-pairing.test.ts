import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { PAIRING_TTL_MS } from '../shared/mobile-gateway'
import { MobilePairingStore } from './mobile-pairing'
import type { PairedDeviceRecord } from '../shared/mobile-gateway'

function store(now: { value: number }, devices: PairedDeviceRecord[] = []) {
  let seq = 0
  return new MobilePairingStore({
    now: () => now.value,
    random: (size) => {
      const bytes = Buffer.alloc(size, seq + 3)
      seq++
      return bytes
    },
    load: () => devices,
    save: (next) => {
      devices.length = 0
      devices.push(...next)
    }
  })
}

describe('mobile pairing store', () => {
  it('issues a one-time pairing token and mints a device grant', () => {
    const now = { value: 1_000 }
    const devices: PairedDeviceRecord[] = []
    const pairing = store(now, devices)
    const offer = pairing.createOffer()
    expect(offer.token).toHaveLength(8)
    expect(offer.expiresAt).toBe(1_000 + PAIRING_TTL_MS)
    const grant = pairing.pair(offer.token, '  iPhone 15 \n')
    expect(grant.device.name).toBe('iPhone 15')
    expect(grant.deviceToken.startsWith(grant.deviceId + '.')).toBe(true)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.tokenHash).toBe(
      createHash('sha256').update(grant.deviceToken.slice(grant.deviceId.length + 1), 'utf8').digest('hex')
    )
    expect(() => pairing.pair(offer.token, 'again')).toThrow('配对码')
    expect(pairing.authenticate(grant.deviceToken)?.deviceId).toBe(grant.deviceId)
  })

  it('rejects expired tokens, unknown credentials, and revoked devices', () => {
    const now = { value: 5_000 }
    const devices: PairedDeviceRecord[] = []
    const pairing = store(now, devices)
    const offer = pairing.createOffer()
    now.value += PAIRING_TTL_MS + 1
    expect(() => pairing.pair(offer.token, 'phone')).toThrow('过期')
    const fresh = pairing.createOffer()
    const grant = pairing.pair(fresh.token, 'phone')
    expect(pairing.authenticate(grant.deviceId + '.' + '00'.repeat(32))).toBeNull()
    expect(pairing.revoke(grant.deviceId)).toBe(true)
    expect(pairing.authenticate(grant.deviceToken)).toBeNull()
    expect(pairing.list()).toEqual([])
  })
})
