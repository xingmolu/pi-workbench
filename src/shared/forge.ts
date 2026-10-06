/**
 * Code hosting ("forge") data shared by Main and the code review plugin page. Providers map
 * their own API onto these shapes; the open-source build ships GitHub, and Gitee follows.
 */

export type ForgeProviderId = 'github' | 'gitee'

export type ForgeRepository = {
  /** null when the project's remote is not on a supported host. */
  provider: ForgeProviderId | null
  host: string | null
  owner: string | null
  repo: string | null
  webUrl: string | null
  /** A token is available for this host. */
  signedIn: boolean
  /** The signed-in account, when the token was accepted. */
  viewer: string | null
  /** Why this repository cannot be browsed, when it cannot. */
  reason?: string
}

export type ForgePullSummary = {
  number: number
  title: string
  author: string
  draft: boolean
  headRef: string
  baseRef: string
  updatedAt: string
  url: string
}

export type ForgePullList = {
  viewer: string | null
  mine: ForgePullSummary[]
  reviewRequested: ForgePullSummary[]
  others: ForgePullSummary[]
}

export type ForgeCheck = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  url: string | null
}

export type ForgeReview = {
  author: string
  state: string
  submittedAt: string | null
}

export type ForgePullDetail = ForgePullSummary & {
  body: string
  state: 'open' | 'closed' | 'merged'
  /** null while the host is still computing it. */
  mergeable: boolean | null
  mergeableState: string | null
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
  comments: number
  checks: ForgeCheck[]
  reviews: ForgeReview[]
  /** Pull requests stacked below (bases) and above (built on this one), oldest base first. */
  stack: { number: number; title: string; current: boolean }[]
}

export type ForgePullFile = {
  path: string
  previousPath?: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** Unified diff hunks; absent for binary or very large files. */
  patch?: string
}

export type ForgeMergeMethod = 'merge' | 'squash' | 'rebase'

/** Settings › 代码托管: where each host's token comes from, and saving one. */
export type ForgeAccount = {
  host: string
  source: 'saved' | 'environment' | 'gh' | null
  viewer: string | null
}

export type ForgeAccountsCommand =
  | { type: 'list' }
  | { type: 'token:set'; host: string; token: string }
  | { type: 'token:clear'; host: string }

export const FORGE_ACCOUNTS_CHANNEL = 'pi:forge-accounts'
export const FORGE_HOSTS = ['github.com'] as const
