import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { MOBILE_GATEWAY_LOOPBACK } from '../shared/mobile-gateway'
import { t } from '../shared/i18n'

const SKIP_IFACE = /^(lo|docker|br-|veth|tun|utun|awdl|llw|bridge|vmnet|vboxnet|dummy|cni|flannel)/i

export function isLoopbackAddress(address: string): boolean {
  return address === MOBILE_GATEWAY_LOOPBACK || address === '::1' || address === 'localhost'
}

export function isRfc1918Ipv4(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((value) => value > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function isForbiddenWildcardBind(address: string): boolean {
  return (
    address === '0.0.0.0' ||
    address === '::' ||
    address === '[::]' ||
    address === '*' ||
    address === '::0'
  )
}

/** Gateway may bind loopback, or one RFC1918 LAN address — never all interfaces. */
export function assertGatewayBindAddress(address: string): void {
  if (isForbiddenWildcardBind(address)) {
    throw new Error(t('手机网关禁止绑定 0.0.0.0 / 全部网卡'))
  }
  if (isLoopbackAddress(address) || isRfc1918Ipv4(address)) return
  throw new Error(t('手机网关只能绑定 127.0.0.1 或当前局域网私网地址'))
}

export function listLanIpv4(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): string[] {
  const found: { name: string; address: string }[] = []
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries || SKIP_IFACE.test(name)) continue
    for (const entry of entries) {
      if (entry.internal || entry.family !== 'IPv4') continue
      if (!isRfc1918Ipv4(entry.address)) continue
      found.push({ name, address: entry.address })
    }
  }
  found.sort((left, right) => {
    const rank = (name: string): number =>
      /^(en0|eth0|wlan0|wi-fi|wifi)/i.test(name) ? 0 : /^(en|eth|wl)/i.test(name) ? 1 : 2
    return rank(left.name) - rank(right.name)
  })
  return [...new Set(found.map((item) => item.address))]
}

export function primaryLanIpv4(ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  return listLanIpv4(ifaces)[0] ?? null
}

export function pairingUrl(host: string, port: number, token?: string): string {
  const url = new URL(`http://${host}:${port}/`)
  if (token) url.searchParams.set('pair', token)
  return url.toString()
}
