import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { TailscaleGatewayStatus } from '../shared/mobile-gateway'

const execFileAsync = promisify(execFile)

export const MISSING_TAILSCALE_CLI =
  '未找到 Tailscale CLI。安装 Tailscale 后即可把回环网关代理到尾网。'

/** Absolute locations Electron GUI apps often miss because Homebrew is not on PATH. */
export const TAILSCALE_BINARY_CANDIDATES = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale'
] as const

const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Applications/Tailscale.app/Contents/MacOS'
]

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: {
    timeout?: number
    maxBuffer?: number
    env?: NodeJS.ProcessEnv
  }
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>

export type TailscaleIo = {
  exec?: ExecFileFn
  exists?: (file: string) => boolean | Promise<boolean>
  which?: () => Promise<string | null>
  resolveBinary?: () => Promise<string | null>
  envPath?: string
}

function asIo(input?: ExecFileFn | TailscaleIo): TailscaleIo {
  if (typeof input === 'function') return { exec: input }
  return input ?? {}
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stdoutText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8')
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

export function augmentPath(pathEnv = process.env.PATH ?? ''): string {
  const parts = pathEnv.split(delimiter).filter(Boolean)
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(delimiter)
}

function defaultExists(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function pathExists(
  file: string,
  exists: TailscaleIo['exists'] = defaultExists
): Promise<boolean> {
  return exists(file)
}

export function missingTailscaleStatus(): TailscaleGatewayStatus {
  return {
    available: false,
    online: false,
    magicDns: null,
    serveUrl: null,
    binary: null,
    error: MISSING_TAILSCALE_CLI
  }
}

export function tailscaleServeCommand(port: number, binary = 'tailscale'): string {
  return `${binary} serve --bg http://127.0.0.1:${port}`
}

export function remotePairingUrl(input: {
  serveUrl?: string | null
  magicDns?: string | null
  token?: string
}): string | null {
  const serve = input.serveUrl?.trim().replace(/\/+$/, '') ?? ''
  const dns = input.magicDns?.trim().replace(/\.$/, '') ?? ''
  let origin: string | null = null
  if (serve.startsWith('https://') && serve.includes('.ts.net')) origin = serve
  else if (dns.includes('.ts.net')) origin = `https://${dns}`
  if (!origin) return null
  const url = new URL(origin.endsWith('/') ? origin : `${origin}/`)
  if (input.token) url.searchParams.set('pair', input.token)
  return url.toString()
}

export async function resolveTailscaleBinary(
  io: ExecFileFn | TailscaleIo = {}
): Promise<string | null> {
  const options = asIo(io)
  if (options.resolveBinary) return options.resolveBinary()
  const exists = options.exists ?? defaultExists
  for (const candidate of TAILSCALE_BINARY_CANDIDATES) {
    if (await pathExists(candidate, exists)) return candidate
  }
  const pathEnv = augmentPath(options.envPath ?? process.env.PATH)
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'tailscale')
    if (await pathExists(candidate, exists)) return candidate
  }
  if (options.which) {
    const found = await options.which()
    if (found && (await pathExists(found, exists))) return found
    return null
  }
  try {
    const exec = options.exec ?? execFileAsync
    const { stdout } = await exec('which', ['tailscale'], {
      timeout: 1500,
      env: { ...process.env, PATH: pathEnv }
    })
    const found = stdoutText(stdout).trim().split('\n')[0]
    if (found && (await pathExists(found, exists))) return found
  } catch {
    /* which is a fallback only */
  }
  return null
}

async function runTailscale(
  io: TailscaleIo,
  bin: string,
  args: readonly string[],
  timeout: number,
  maxBuffer = 256 * 1024
): Promise<{ stdout: string }> {
  const exec = io.exec ?? execFileAsync
  const result = await exec(bin, args, {
    timeout,
    maxBuffer,
    env: { ...process.env, PATH: augmentPath(io.envPath ?? process.env.PATH) }
  })
  return { stdout: stdoutText(result.stdout) }
}

export async function probeTailscale(
  io: ExecFileFn | TailscaleIo = {}
): Promise<TailscaleGatewayStatus> {
  const options = asIo(io)
  const binary = await resolveTailscaleBinary(options)
  if (!binary) return missingTailscaleStatus()
  try {
    const { stdout } = await runTailscale(options, binary, ['status', '--json'], 2500, 1024 * 1024)
    const parsed = asRecord(JSON.parse(stdout))
    if (!parsed) throw new Error('Tailscale 状态不可读')
    const self = asRecord(parsed.Self) ?? asRecord(parsed.self)
    const magicDns =
      typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null
    const online = self?.Online === true || parsed.BackendState === 'Running'
    let serveUrl: string | null = null
    try {
      const serve = await runTailscale(options, binary, ['serve', 'status', '--json'], 2500)
      serveUrl = firstHttpsUrl(JSON.parse(serve.stdout))
    } catch {
      serveUrl = null
    }
    return {
      available: true,
      online: Boolean(online || magicDns),
      magicDns,
      serveUrl,
      binary,
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
      binary,
      error: missing ? MISSING_TAILSCALE_CLI : message
    }
  }
}

export async function enableTailscaleServe(
  port: number,
  io: ExecFileFn | TailscaleIo = {}
): Promise<TailscaleGatewayStatus> {
  const options = asIo(io)
  const binary = await resolveTailscaleBinary(options)
  if (!binary) return missingTailscaleStatus()
  try {
    await runTailscale(options, binary, ['serve', '--bg', `http://127.0.0.1:${port}`], 8000)
    return probeTailscale(options)
  } catch (error) {
    const probed = await probeTailscale(options)
    const message = error instanceof Error ? error.message : String(error)
    return { ...probed, binary, error: probed.error ?? message }
  }
}

export async function disableTailscaleServe(
  io: ExecFileFn | TailscaleIo = {}
): Promise<TailscaleGatewayStatus> {
  const options = asIo(io)
  const binary = await resolveTailscaleBinary(options)
  if (!binary) return missingTailscaleStatus()
  try {
    await runTailscale(options, binary, ['serve', 'off'], 8000)
    return probeTailscale(options)
  } catch (error) {
    const probed = await probeTailscale(options)
    const message = error instanceof Error ? error.message : String(error)
    return { ...probed, binary, error: probed.error ?? message }
  }
}
