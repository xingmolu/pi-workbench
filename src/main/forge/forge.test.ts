import { describe, expect, it, vi } from 'vitest'
import { GitHubForge, type ForgeFetch } from './github'
import { forgeProviderFor, parseForgeRemote } from './remote'
import { ForgeService } from './service'

function json(status: number, body: unknown): Awaited<ReturnType<ForgeFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

/** A tiny GitHub: routes by method and path suffix. */
function fakeGitHub(routes: Record<string, unknown | ((body: unknown) => unknown)>): {
  fetch: ForgeFetch
  calls: { method: string; url: string; body?: unknown; auth?: string }[]
} {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = []
  const fetch: ForgeFetch = vi.fn(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, url, body, auth: init.headers.Authorization })
    const path = url.replace(/^https:\/\/api\.github\.com/, '')
    const key = Object.keys(routes).find((route) => {
      const [method, pattern] = route.split(' ')
      return method === init.method && path.split('?')[0] === pattern
    })
    if (!key) return json(404, { message: 'Not Found' })
    const route = routes[key]
    const value = typeof route === 'function' ? (route as (body: unknown) => unknown)(body) : route
    return value instanceof Object && 'status' in value && 'payload' in value
      ? json((value as { status: number }).status, (value as { payload: unknown }).payload)
      : json(200, value)
  })
  return { fetch, calls }
}

const pull = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `PR ${number}`,
  user: { login: 'author' },
  draft: false,
  head: { ref: `branch-${number}`, sha: `sha${number}` },
  base: { ref: 'main' },
  updated_at: '2026-10-05T00:00:00Z',
  html_url: `https://github.com/acme/app/pull/${number}`,
  requested_reviewers: [],
  ...extra
})

describe('parseForgeRemote', () => {
  it.each([
    ['https://github.com/acme/app.git', 'github.com'],
    ['https://token@github.com/acme/app', 'github.com'],
    ['git@github.com:acme/app.git', 'github.com'],
    ['ssh://git@github.com:22/acme/app.git', 'github.com'],
    ['git@gitee.com:acme/app.git', 'gitee.com']
  ])('reads %s', (url, host) => {
    expect(parseForgeRemote(url)).toEqual({ host, owner: 'acme', repo: 'app' })
  })

  it('rejects local paths and odd names', () => {
    expect(parseForgeRemote('/srv/repos/app.git')).toBeNull()
    expect(parseForgeRemote('file:///srv/app')).toBeNull()
    expect(parseForgeRemote('https://github.com/acme')).toBeNull()
    expect(parseForgeRemote('https://github.com/ac me/app')).toBeNull()
  })

  it('knows GitHub and Gitee only', () => {
    expect(forgeProviderFor('github.com')).toBe('github')
    expect(forgeProviderFor('gitee.com')).toBe('gitee')
    expect(forgeProviderFor('gitlab.com')).toBeNull()
  })
})

describe('GitHubForge', () => {
  it('sorts open pull requests into mine, requested and others', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /user': { login: 'me' },
      'GET /repos/acme/app/pulls': [
        pull(1, { user: { login: 'me' } }),
        pull(2, { requested_reviewers: [{ login: 'me' }] }),
        pull(3)
      ]
    })
    const forge = new GitHubForge({ owner: 'acme', repo: 'app', token: 'secret', fetch })
    const pulls = await forge.pulls()
    expect(pulls.viewer).toBe('me')
    expect(pulls.mine.map(({ number }) => number)).toEqual([1])
    expect(pulls.reviewRequested.map(({ number }) => number)).toEqual([2])
    expect(pulls.others.map(({ number }) => number)).toEqual([3])
    expect(calls.every(({ auth }) => auth === 'Bearer secret')).toBe(true)
  })

  it('assembles a pull request with checks, latest reviews and its stack', async () => {
    const { fetch } = fakeGitHub({
      'GET /repos/acme/app/pulls/2': pull(2, {
        base: { ref: 'branch-1' },
        body: 'Body',
        state: 'open',
        mergeable: true,
        mergeable_state: 'clean',
        additions: 5,
        deletions: 1,
        changed_files: 2,
        comments: 1,
        review_comments: 2
      }),
      'GET /repos/acme/app/commits/sha2/check-runs': {
        check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }]
      },
      'GET /repos/acme/app/pulls/2/reviews': [
        { user: { login: 'r' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'r' }, state: 'APPROVED' },
        { user: { login: 'r' }, state: 'COMMENTED' }
      ],
      'GET /repos/acme/app/pulls': [
        pull(1),
        pull(2, { base: { ref: 'branch-1' } }),
        pull(3, { base: { ref: 'branch-2' } }),
        pull(4)
      ]
    })
    const detail = await new GitHubForge({ owner: 'acme', repo: 'app', token: 't', fetch }).pull(2)
    expect(detail).toMatchObject({
      number: 2,
      body: 'Body',
      state: 'open',
      mergeable: true,
      comments: 3,
      checks: [{ name: 'verify', conclusion: 'success' }],
      reviews: [{ author: 'r', state: 'APPROVED' }]
    })
    expect(detail.stack).toEqual([
      { number: 1, title: 'PR 1', current: false },
      { number: 2, title: 'PR 2', current: true },
      { number: 3, title: 'PR 3', current: false }
    ])
  })

  it('merges only the approved head and turns refusals into readable errors', async () => {
    const { fetch, calls } = fakeGitHub({
      'PUT /repos/acme/app/pulls/5/merge': { merged: true },
      'PUT /repos/acme/app/pulls/6/merge': {
        status: 409,
        payload: { message: 'Head branch was modified' }
      },
      'POST /repos/acme/app/issues/5/comments': { html_url: 'https://github.com/c/1' }
    })
    const forge = new GitHubForge({ owner: 'acme', repo: 'app', token: 't', fetch })
    await forge.merge(5, 'squash', 'abc')
    expect(calls[0].body).toEqual({ merge_method: 'squash', sha: 'abc' })
    await expect(forge.merge(6, 'merge', 'def')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Head branch was modified'
    })
    await expect(forge.comment(5, 'LGTM')).resolves.toEqual({ url: 'https://github.com/c/1' })
    await expect(forge.files(9)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('ForgeService', () => {
  const service = (options: {
    remote?: string | null
    saved?: string
    env?: NodeJS.ProcessEnv
    gh?: string | null
  }): { stored: Map<string, string>; forge: ForgeService } => {
    const stored = new Map<string, string>(options.saved ? [['github.com', options.saved]] : [])
    const { fetch } = fakeGitHub({ 'GET /user': { login: 'me' } })
    return {
      stored,
      forge: new ForgeService({
        remoteUrl: async () => options.remote ?? null,
        tokens: {
          read: (host) => stored.get(host),
          write: (host, token) => (token ? stored.set(host, token) : stored.delete(host))
        },
        fetch,
        env: options.env ?? {},
        ghToken: async () => options.gh ?? null
      })
    }
  }

  it('prefers a saved token, then the environment, then the GitHub CLI', async () => {
    expect(
      await service({ saved: 'saved-token', env: { GH_TOKEN: 'env' } }).forge.token('github.com')
    ).toEqual({ token: 'saved-token', source: 'saved' })
    expect(
      await service({ env: { GITHUB_TOKEN: 'env' }, gh: 'gh' }).forge.token('github.com')
    ).toEqual({ token: 'env', source: 'environment' })
    expect(await service({ gh: 'gh-token' }).forge.token('github.com')).toEqual({
      token: 'gh-token',
      source: 'gh'
    })
    expect(await service({}).forge.token('github.com')).toBeNull()
  })

  it('describes the repository and why it cannot be browsed', async () => {
    await expect(
      service({ remote: 'git@github.com:acme/app.git', gh: 'tok' }).forge.repository('/p')
    ).resolves.toMatchObject({
      provider: 'github',
      owner: 'acme',
      repo: 'app',
      signedIn: true,
      viewer: 'me',
      webUrl: 'https://github.com/acme/app'
    })
    expect(
      (await service({ remote: 'https://github.com/acme/app' }).forge.repository('/p')).reason
    ).toContain('还没有登录')
    expect(
      (await service({ remote: 'git@gitee.com:acme/app.git' }).forge.repository('/p')).reason
    ).toContain('Gitee')
    expect((await service({ remote: null }).forge.repository('/p')).provider).toBeNull()
  })

  it('saves a token only after GitHub accepts it, and forgets it', async () => {
    const { forge, stored } = service({})
    await expect(forge.saveToken('github.com', 'new-token')).resolves.toEqual({ viewer: 'me' })
    expect(stored.get('github.com')).toBe('new-token')
    await forge.saveToken('github.com', null)
    expect(stored.has('github.com')).toBe(false)
  })
})
