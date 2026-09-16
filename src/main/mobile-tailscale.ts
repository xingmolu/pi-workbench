import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TailscaleGatewayStatus } from '../shared/mobile-gateway'

const execFileAsync = promisify(execFile)

type ExecFileFn = typeof execFileAsync

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstHttpsUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('https://') && value.includes('.ts.net')) {
    return value.replace(/\/+$/, '')
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpsUrl(item)
      if (found) return found
    }
  }
  const record = asRecord(value)
  if (!record) return null
  for (const item of Object.values(record)) {
    const found = firstHttpsUrl(item)
    if (found) return found
  }
  return null
}

export async function probeTailscale(
  exec: ExecFileFn = execFileAsync
): Promise<TailscaleGatewayStatus> {
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], {
      timeout: 2500,
      maxBuffer: 1024 * 1024
    })
    const parsed = asRecord(JSON.parse(stdout))
    if (!parsed) throw new Error('Tailscale 状态不可读')
    const self = asRecord(parsed.Self) ?? asRecord(parsed.self)
    const magicDns =
      typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null
    const online = self?.Online === true || parsed.BackendState === 'Running'
    let serveUrl: string | null = null
    try {
      const serve = await exec('tailscale', ['serve', 'status', '--json'], {
        timeout: 2500,
        maxBuffer: 256 * 1024
      })
      serveUrl = firstHttpsUrl(JSON.parse(serve.stdout))
    } catch {
      serveUrl = null
    }
    return {
      available: true,
      online: Boolean(online || magicDns),
      magicDns,
      serveUrl,
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const missing = /ENOENT|not found|N[oO] such file/.test(message)
    return {
      available: false,
      online: false,
      magicDns: null,
      serveUrl: null,
      error: missing ? '未找到 Tailscale CLI。安装 Tailscale 后即可把回环网关代理到尾网。' : message
    }
  }
}

export async function enableTailscaleServe(
  port: number,
  exec: ExecFileFn = execFileAsync
): Promise<TailscaleGatewayStatus> {
  await exec('tailscale', ['serve', '--bg', `http://127.0.0.1:${port}`], {
    timeout: 8000,
    maxBuffer: 256 * 1024
  })
  return probeTailscale(exec)
}

export async function disableTailscaleServe(
  exec: ExecFileFn = execFileAsync
): Promise<TailscaleGatewayStatus> {
  await exec('tailscale', ['serve', 'off'], {
    timeout: 8000,
    maxBuffer: 256 * 1024
  })
  return probeTailscale(exec)
}
