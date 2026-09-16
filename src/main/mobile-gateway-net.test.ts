import { describe, expect, it } from 'vitest'
import {
  assertGatewayBindAddress,
  isForbiddenWildcardBind,
  listLanIpv4,
  pairingUrl
} from './mobile-gateway-net'

describe('mobile gateway bind addresses', () => {
  it('never allows 0.0.0.0 or IPv6 any', () => {
    for (const address of ['0.0.0.0', '::', '[::]', '*', '::0']) {
      expect(isForbiddenWildcardBind(address)).toBe(true)
      expect(() => assertGatewayBindAddress(address)).toThrow('0.0.0.0')
    }
    expect(() => assertGatewayBindAddress('8.8.8.8')).toThrow('127.0.0.1')
    expect(() => assertGatewayBindAddress('127.0.0.1')).not.toThrow()
    expect(() => assertGatewayBindAddress('192.168.1.20')).not.toThrow()
    expect(() => assertGatewayBindAddress('10.0.0.4')).not.toThrow()
  })

  it('picks RFC1918 LAN addresses and skips virtual / public / Tailscale CGNAT', () => {
    expect(
      listLanIpv4({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '', netmask: '', cidr: null }],
        en0: [
          { address: '192.168.0.12', family: 'IPv4', internal: false, mac: '', netmask: '', cidr: null }
        ],
        utun4: [
          { address: '100.100.12.4', family: 'IPv4', internal: false, mac: '', netmask: '', cidr: null }
        ],
        docker0: [
          { address: '172.17.0.1', family: 'IPv4', internal: false, mac: '', netmask: '', cidr: null }
        ]
      })
    ).toEqual(['192.168.0.12'])
    expect(pairingUrl('192.168.0.12', 43124, 'ABCD2345')).toBe(
      'http://192.168.0.12:43124/?pair=ABCD2345'
    )
  })
})
