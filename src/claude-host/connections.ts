import { mkdir, rm, symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { claudeEnvironment, type ClaudeConfig } from './config'
import type { ClaudeStorage } from './storage'

/** The login that lived in the default configuration home before accounts existed. */
export const DEFAULT_CONNECTION = 'anthropic'

export type ClaudeConnection =
  | { id: string; kind: 'default'; email?: string; plan?: string }
  | { id: string; kind: 'account'; email?: string; plan?: string }
  | { id: string; kind: 'api'; label?: string; baseUrl?: string }

/**
 * Every way this engine can reach Claude: the default home (subscription login or the
 * legacy API key), each extra subscription account, and each API connection.
 */
export function connections(config: ClaudeConfig): ClaudeConnection[] {
  return [
    {
      id: DEFAULT_CONNECTION,
      kind: 'default',
      ...(config.email ? { email: config.email } : {}),
      ...(config.plan ? { plan: config.plan } : {})
    },
    ...(config.accounts ?? []).map((account) => ({ ...account, kind: 'account' as const })),
    ...(config.apis ?? []).map(({ id, label, baseUrl }) => ({
      id,
      kind: 'api' as const,
      ...(label ? { label } : {}),
      ...(baseUrl ? { baseUrl } : {})
    }))
  ]
}

export function activeConnection(config: ClaudeConfig): string {
  const active = config.active
  return active && connections(config).some((item) => item.id === active)
    ? active
    : DEFAULT_CONNECTION
}

export function accountHome(storage: ClaudeStorage, id: string): string {
  if (!/^claude-[a-z0-9]{6,16}$/.test(id)) throw new Error('Invalid Claude account id')
  return join(storage.config, 'accounts', id)
}

/**
 * A separate configuration home keeps each login apart (the CLI derives its keychain item
 * from the home path) while `projects` points at the shared transcripts, so a session can
 * resume under whichever account the user picks.
 */
export async function prepareAccountHome(storage: ClaudeStorage, id: string): Promise<string> {
  const home = accountHome(storage, id)
  await mkdir(join(storage.config, 'projects'), { recursive: true })
  await mkdir(home, { recursive: true })
  const link = join(home, 'projects')
  const existing = await lstat(link).catch(() => undefined)
  if (!existing)
    await symlink(
      join(storage.config, 'projects'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  return home
}

export async function removeAccountHome(storage: ClaudeStorage, id: string): Promise<void> {
  // rm removes the projects link itself, never the shared transcripts it points at.
  await rm(accountHome(storage, id), { recursive: true, force: true })
}

export function newConnectionId(kind: 'account' | 'api'): string {
  return `${kind === 'account' ? 'claude' : 'claude-api'}-${randomBytes(4).toString('hex')}`
}

/** The child environment for one connection; never mixes another connection's secrets. */
export function connectionEnvironment(
  storage: ClaudeStorage,
  config: ClaudeConfig,
  id: string,
  parent = process.env
): Record<string, string | undefined> {
  if (id === DEFAULT_CONNECTION) return claudeEnvironment(storage, config, parent)
  const api = config.apis?.find((item) => item.id === id)
  if (api)
    return claudeEnvironment(
      storage,
      {
        apiKey: api.apiKey,
        ...(api.baseUrl ? { baseUrl: api.baseUrl } : {}),
        ...(api.bearer ? { bearer: true } : {})
      },
      parent
    )
  if (config.accounts?.some((item) => item.id === id))
    return claudeEnvironment(storage, {}, parent, accountHome(storage, id))
  throw new Error('Unknown Claude connection')
}
