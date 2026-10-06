import type {
  ForgeCheck,
  ForgeMergeMethod,
  ForgePullDetail,
  ForgePullFile,
  ForgePullList,
  ForgePullSummary,
  ForgeReview
} from '../../shared/forge'
import { PluginApiError } from '../../shared/plugin-api'
import { t } from '../../shared/i18n'

export type ForgeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

type Json = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
const obj = (value: unknown): Json =>
  value && typeof value === 'object' ? (value as Json) : ({} as Json)
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : [])

function summary(pull: Json): ForgePullSummary {
  return {
    number: num(pull.number),
    title: str(pull.title),
    author: str(obj(pull.user).login),
    draft: pull.draft === true,
    headRef: str(obj(pull.head).ref),
    baseRef: str(obj(pull.base).ref),
    updatedAt: str(pull.updated_at),
    url: str(pull.html_url)
  }
}

/**
 * The GitHub REST API for one repository. The token stays here: plugin pages see only the
 * shapes in `shared/forge`, never the credential or raw responses.
 */
export class GitHubForge {
  constructor(
    private readonly options: {
      owner: string
      repo: string
      token: string
      fetch: ForgeFetch
      /** api.github.com, or a GitHub Enterprise `https://host/api/v3`. */
      apiBase?: string
    }
  ) {}

  private get base(): string {
    return `${this.options.apiBase ?? 'https://api.github.com'}/repos/${encodeURIComponent(
      this.options.owner
    )}/${encodeURIComponent(this.options.repo)}`
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<unknown> {
    const url = path.startsWith('https://')
      ? path
      : path.startsWith('/user')
        ? `${this.options.apiBase ?? 'https://api.github.com'}${path}`
        : `${this.base}${path}`
    let response: Awaited<ReturnType<ForgeFetch>>
    try {
      response = await this.options.fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Pi-Desktop',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(20_000)
      })
    } catch (error) {
      throw new PluginApiError(
        error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'INTERNAL',
        t('无法连接 GitHub，请检查网络')
      )
    }
    if (response.ok) return response.status === 204 ? null : response.json()
    let message = ''
    try {
      message = str(obj(await response.json()).message)
    } catch {
      /* not JSON */
    }
    if (response.status === 401)
      throw new PluginApiError('PERMISSION_DENIED', t('GitHub 令牌无效或已过期，请重新登录'))
    if (response.status === 403 || response.status === 404)
      throw new PluginApiError(
        response.status === 404 ? 'NOT_FOUND' : 'PERMISSION_DENIED',
        t('GitHub 拒绝了请求：{message}', { message: message || String(response.status) })
      )
    if (response.status === 405 || response.status === 409 || response.status === 422)
      throw new PluginApiError(
        'CONFLICT',
        message || t('GitHub 无法完成这个操作（{status}）', { status: response.status })
      )
    throw new PluginApiError(
      'INTERNAL',
      t('GitHub 请求失败（{status}）', { status: response.status })
    )
  }

  async viewer(): Promise<string> {
    return str(obj(await this.request('/user')).login)
  }

  private async openPulls(): Promise<Json[]> {
    return list(await this.request('/pulls?state=open&per_page=100&sort=updated&direction=desc'))
  }

  async pulls(): Promise<ForgePullList> {
    const [viewer, pulls] = await Promise.all([this.viewer(), this.openPulls()])
    const result: ForgePullList = { viewer, mine: [], reviewRequested: [], others: [] }
    for (const pull of pulls) {
      const item = summary(pull)
      if (item.author === viewer) result.mine.push(item)
      else if (list(pull.requested_reviewers).some((user) => str(user.login) === viewer))
        result.reviewRequested.push(item)
      else result.others.push(item)
    }
    return result
  }

  async pull(number: number): Promise<ForgePullDetail> {
    const pull = obj(await this.request(`/pulls/${number}`))
    const headSha = str(obj(pull.head).sha)
    const [checks, reviews, open] = await Promise.all([
      this.request(`/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`)
        .then((value) => list(obj(value).check_runs))
        .catch(() => [] as Json[]),
      this.request(`/pulls/${number}/reviews?per_page=100`)
        .then(list)
        .catch(() => [] as Json[]),
      pull.state === 'open' ? this.openPulls().catch(() => [] as Json[]) : Promise.resolve([])
    ])
    const item = summary(pull)
    return {
      ...item,
      body: str(pull.body),
      state:
        pull.merged === true || pull.merged_at
          ? 'merged'
          : pull.state === 'closed'
            ? 'closed'
            : 'open',
      mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
      mergeableState: typeof pull.mergeable_state === 'string' ? pull.mergeable_state : null,
      headSha,
      additions: num(pull.additions),
      deletions: num(pull.deletions),
      changedFiles: num(pull.changed_files),
      comments: num(pull.comments) + num(pull.review_comments),
      checks: checks.map((run): ForgeCheck => ({
        name: str(run.name),
        status: run.status === 'completed' || run.status === 'in_progress' ? run.status : 'queued',
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
        url: str(run.html_url) || null
      })),
      reviews: latestReviews(reviews),
      stack: stackOf(item, open.map(summary))
    }
  }

  async files(number: number): Promise<ForgePullFile[]> {
    const files: ForgePullFile[] = []
    // GitHub lists at most 3000 files; three pages cover what a review page can show.
    for (let page = 1; page <= 3; page++) {
      const batch = list(await this.request(`/pulls/${number}/files?per_page=100&page=${page}`))
      for (const file of batch)
        files.push({
          path: str(file.filename),
          ...(file.previous_filename ? { previousPath: str(file.previous_filename) } : {}),
          status: (str(file.status) || 'modified') as ForgePullFile['status'],
          additions: num(file.additions),
          deletions: num(file.deletions),
          ...(typeof file.patch === 'string' ? { patch: file.patch } : {})
        })
      if (batch.length < 100) break
    }
    return files
  }

  async merge(number: number, method: ForgeMergeMethod, headSha: string): Promise<void> {
    // The approved head: a push after approval makes GitHub refuse instead of merging it.
    await this.request(`/pulls/${number}/merge`, {
      method: 'PUT',
      body: { merge_method: method, sha: headSha }
    })
  }

  async comment(number: number, body: string): Promise<{ url: string }> {
    const created = obj(
      await this.request(`/issues/${number}/comments`, { method: 'POST', body: { body } })
    )
    return { url: str(created.html_url) }
  }
}

/** Each reviewer's latest decisive review; comments alone do not replace a decision. */
function latestReviews(reviews: Json[]): ForgeReview[] {
  const byAuthor = new Map<string, ForgeReview>()
  for (const review of reviews) {
    const author = str(obj(review.user).login)
    const state = str(review.state)
    if (!author || (state === 'COMMENTED' && byAuthor.has(author))) continue
    byAuthor.set(author, {
      author,
      state,
      submittedAt: str(review.submitted_at) || null
    })
  }
  return [...byAuthor.values()]
}

/** The chain of open pull requests this one sits on and those built on it. */
function stackOf(current: ForgePullSummary, open: ForgePullSummary[]): ForgePullDetail['stack'] {
  const byHead = new Map(open.map((pull) => [pull.headRef, pull]))
  const below: ForgePullSummary[] = []
  const seen = new Set([current.number])
  for (let base = byHead.get(current.baseRef); base && !seen.has(base.number);) {
    below.unshift(base)
    seen.add(base.number)
    base = byHead.get(base.baseRef)
  }
  const above: ForgePullSummary[] = []
  for (
    let next = open.find((pull) => pull.baseRef === current.headRef && !seen.has(pull.number));
    next;
    next = open.find((pull) => pull.baseRef === next!.headRef && !seen.has(pull.number))
  ) {
    above.push(next)
    seen.add(next.number)
  }
  if (!below.length && !above.length) return []
  return [...below, current, ...above].map((pull) => ({
    number: pull.number,
    title: pull.title,
    current: pull.number === current.number
  }))
}
