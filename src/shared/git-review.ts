import { z } from 'zod'

export const GIT_REVIEW_CHANNEL = 'pi:git-review'
const projectPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes('\0'))
const id = z.string().min(1).max(128)
// Only full local branch/ref names, never revision expressions or command options.
export const gitReviewRefSchema = z
  .string()
  .max(1024)
  .refine(
    (s) =>
      /^refs\/(heads|remotes)\/.+/.test(s) &&
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(s) &&
      !s.includes('..') &&
      !s.includes('@{') &&
      s
        .split('/')
        .every(
          (part) => part && !part.startsWith('.') && !part.endsWith('.lock') && !part.endsWith('.')
        )
  )
export const gitReviewCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refs'), projectPath }).strict(),
  z
    .object({
      type: z.literal('list'),
      projectPath,
      view: z.enum(['unstaged', 'staged', 'branch']),
      baseRef: gitReviewRefSchema.optional()
    })
    .strict()
    .refine((command) => command.view === 'branch' || command.baseRef === undefined),
  z.object({ type: z.literal('patch'), projectPath, reviewId: id, entryId: id }).strict()
])
export type GitReviewCommand = z.infer<typeof gitReviewCommandSchema>
export type GitReviewView = 'unstaged' | 'staged' | 'branch'
export type GitReviewUnavailableReason =
  | 'invalid-request'
  | 'no-project'
  | 'project-changed'
  | 'project-unavailable'
  | 'stale-review'
  | 'git-unavailable'
  | 'git-version'
  | 'not-repository'
  | 'bare-repository'
  | 'filters-unsupported'
  | 'select-base'
  | 'invalid-base'
  | 'unborn'
  | 'no-common-ancestor'
  | 'multiple-merge-bases'
  | 'unsupported-inventory'
  | 'timeout'
  | 'aborted'
  | 'output-limit'
  | 'busy'
  | 'git-failed'
export type GitReviewUnavailable = {
  type: 'unavailable'
  reason: GitReviewUnavailableReason
  message: string
}
export type GitReviewEntry = {
  entryId: string
  /** Relative to the opened project, independent of human patch headers. */
  path: string
  status: string
  kind: 'tracked' | 'untracked' | 'conflict' | 'symlink' | 'submodule'
  indexStatus?: string
  worktreeStatus?: string
  /** Only untracked paths compatible with the Files API receive a previewPath. */
  previewPath?: string
  previewUnavailable?: string
}
export type GitReviewBranch = {
  baseRef: string
  baseOid: string
  headOid: string
  mergeBaseOid: string
}
export type GitReviewResult =
  | GitReviewUnavailable
  | { type: 'refs'; refs: { name: string; label: string }[] }
  | {
      type: 'list'
      reviewId: string
      view: GitReviewView
      entries: GitReviewEntry[]
      branch?: GitReviewBranch
    }
  | {
      type: 'patch'
      reviewId: string
      entryId: string
      kind: 'text' | 'binary' | 'conflict' | 'submodule' | 'type-only' | 'empty' | 'untracked'
      text?: string
      /** Byte-escaped non-UTF-8 patch: display as plain pre/code, do not parse as a diff. */
      rawOnly?: boolean
      message: string
      previewPath?: string
    }
