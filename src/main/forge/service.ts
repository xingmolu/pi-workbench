import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import type { ForgeRepository } from '../../shared/forge'
import { PluginApiError } from '../../shared/plugin-api'
import { t } from '../../shared/i18n'
import { GitHubForge, type ForgeFetch } from './github'
import { forgeProviderFor, parseForgeRemote, type ForgeRemote } from './remote'

/** Tokens the user saved in Settings, encrypted at rest by Main. */
export type ForgeTokenStore = {
  read(host: string): string | undefined
  write(host: string, token: string | null): void
}

export type ForgeTokenSource = 'saved' | 'environment' | 'gh'

export type ForgeServiceDependencies = {
  /** The fetch or push remote URL of the project's repository, or null without one. */
  remoteUrl(projectPath: string): Promise<string | null>
  tokens: ForgeTokenStore
  fetch: ForgeFetch
  env?: NodeJS.ProcessEnv
  /** `gh auth token --hostname <host>`; null when gh is missing or signed out. */
  ghToken?(host: string): Promise<string | null>
  /** Another GitHub API root; e2e tests point this at a local fake. */
  githubApi?: string
}

/** Where the GitHub CLI usually lives when the app starts without a login shell's PATH. */
const GH_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin']

export function ghTokenReader(env: NodeJS.ProcessEnv = process.env) {
  return (host: string): Promise<string | null> =>
    new Promise((resolve) => {
      const path = [...(env.PATH ?? '').split(delimiter), ...GH_DIRECTORIES]
        .filter(Boolean)
        .join(delimiter)
      execFile(
        'gh',
        ['auth', 'token', '--hostname', host],
        { timeout: 5000, env: { ...env, PATH: path, GH_PROMPT_DISABLED: '1' }, windowsHide: true },
        (error, stdout) => {
          const token = String(stdout ?? '').trim()
          resolve(!error && /^[\w-]{20,}$/.test(token) ? token : null)
        }
      )
    })
}

/**
 * Code hosting for the open project: which provider its remote is on, a token for that host,
 * and a client. Tokens never leave Main; the plugin gateway calls through this service.
 */
export class ForgeService {
  private readonly viewers = new Map<string, Promise<string>>()

  constructor(private readonly deps: ForgeServiceDependencies) {}

  async token(host: string): Promise<{ token: string; source: ForgeTokenSource } | null> {
    const saved = this.deps.tokens.read(host)
    if (saved) return { token: saved, source: 'saved' }
    const env = this.deps.env ?? process.env
    const fromEnv =
      host === 'github.com'
        ? (env.GH_TOKEN ?? env.GITHUB_TOKEN)
        : host === 'gitee.com'
          ? env.GITEE_TOKEN
          : undefined
    if (fromEnv?.trim()) return { token: fromEnv.trim(), source: 'environment' }
    if (forgeProviderFor(host) === 'github') {
      const gh = await (this.deps.ghToken ?? ghTokenReader(env))(host)
      if (gh) return { token: gh, source: 'gh' }
    }
    return null
  }

  private async remote(projectPath: string): Promise<ForgeRemote | null> {
    const url = await this.deps.remoteUrl(projectPath)
    return url ? parseForgeRemote(url) : null
  }

  async repository(projectPath: string): Promise<ForgeRepository> {
    const remote = await this.remote(projectPath)
    const empty: ForgeRepository = {
      provider: null,
      host: null,
      owner: null,
      repo: null,
      webUrl: null,
      signedIn: false,
      viewer: null
    }
    if (!remote) return { ...empty, reason: t('项目没有可识别的远程仓库') }
    const provider = forgeProviderFor(remote.host)
    const repository: ForgeRepository = {
      ...empty,
      provider,
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      webUrl: `https://${remote.host}/${remote.owner}/${remote.repo}`
    }
    if (provider !== 'github')
      return {
        ...repository,
        reason:
          provider === 'gitee'
            ? t('Gitee 将在后续版本支持')
            : t('暂不支持 {host} 上的仓库', { host: remote.host })
      }
    const token = await this.token(remote.host)
    if (!token) return { ...repository, reason: t('还没有登录 {host}', { host: remote.host }) }
    try {
      return { ...repository, signedIn: true, viewer: await this.viewer(remote, token.token) }
    } catch (error) {
      return {
        ...repository,
        signedIn: true,
        reason: error instanceof Error ? error.message : t('无法验证 GitHub 令牌')
      }
    }
  }

  private viewer(remote: ForgeRemote, token: string): Promise<string> {
    const key = `${remote.host}\0${token}`
    let viewer = this.viewers.get(key)
    if (!viewer) {
      viewer = this.github(remote, token).viewer()
      this.viewers.set(key, viewer)
      viewer.catch(() => this.viewers.delete(key))
    }
    return viewer
  }

  private github(remote: ForgeRemote, token: string): GitHubForge {
    return new GitHubForge({
      owner: remote.owner,
      repo: remote.repo,
      token,
      fetch: this.deps.fetch,
      ...(this.deps.githubApi ? { apiBase: this.deps.githubApi } : {})
    })
  }

  /** A client for the project's repository, or an error the page can show as is. */
  async client(projectPath: string): Promise<GitHubForge> {
    const remote = await this.remote(projectPath)
    if (!remote) throw new PluginApiError('NOT_FOUND', t('项目没有可识别的远程仓库'))
    if (forgeProviderFor(remote.host) !== 'github')
      throw new PluginApiError('UNSUPPORTED', t('暂不支持 {host} 上的仓库', { host: remote.host }))
    const token = await this.token(remote.host)
    if (!token)
      throw new PluginApiError('PERMISSION_DENIED', t('还没有登录 {host}', { host: remote.host }))
    return this.github(remote, token.token)
  }

  /** Saves (or with null, forgets) a token, after checking that the host accepts it. */
  async saveToken(host: string, token: string | null): Promise<{ viewer: string | null }> {
    if (!token) {
      this.deps.tokens.write(host, null)
      this.viewers.clear()
      return { viewer: null }
    }
    if (forgeProviderFor(host) !== 'github') throw new Error(t('暂不支持 {host}', { host }))
    const viewer = await this.github({ host, owner: '_', repo: '_' }, token)
      .viewer()
      .catch((error: unknown) => {
        throw new Error(error instanceof Error ? error.message : t('无法验证 GitHub 令牌'))
      })
    this.deps.tokens.write(host, token)
    this.viewers.clear()
    return { viewer }
  }

  /** Where each known host's token comes from, for Settings. */
  async accounts(): Promise<
    { host: string; source: ForgeTokenSource | null; viewer: string | null }[]
  > {
    const host = 'github.com'
    const token = await this.token(host)
    let viewer: string | null = null
    if (token)
      viewer = await this.viewer({ host, owner: '_', repo: '_' }, token.token).catch(() => null)
    return [{ host, source: token?.source ?? null, viewer }]
  }
}
