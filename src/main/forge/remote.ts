import type { ForgeProviderId } from '../../shared/forge'

export type ForgeRemote = { host: string; owner: string; repo: string }

/**
 * The host and repository of a git remote URL: https, ssh (`ssh://` or scp-like
 * `git@host:owner/repo`) and git protocols. Credentials and ports are dropped. Only the
 * first two path segments count, so `owner/repo` on GitHub and Gitee alike.
 */
export function parseForgeRemote(url: string): ForgeRemote | null {
  const text = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol))
      return null
    host = parsed.hostname
    path = parsed.pathname
  } else if (scp) {
    host = scp[1]
    path = scp[2]
  } else return null
  const [owner, repo] = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
  if (!host || !owner || !repo) return null
  if (![owner, repo].every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null
  return { host: host.toLowerCase(), owner, repo }
}

/** Which provider serves a host. Self-hosted instances are configured per host later. */
export function forgeProviderFor(host: string): ForgeProviderId | null {
  if (host === 'github.com' || host === 'www.github.com') return 'github'
  if (host === 'gitee.com') return 'gitee'
  return null
}
