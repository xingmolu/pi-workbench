interface GitStatusMetadata {
  path: string
  indexStatus: string
  worktreeStatus: string
  submodule: string
  worktreeMode: string
}
export type GitStatusEntry =
  | (GitStatusMetadata & {
      kind: 'tracked'
      headMode: string
      indexMode: string
    })
  | (GitStatusMetadata & {
      kind: 'conflict'
      baseMode: string
      oursMode: string
      theirsMode: string
    })
  | { kind: 'untracked'; path: string; directory?: true }

export interface GitNameStatusEntry {
  status: string
  path: string
}
export interface GitRawEntry extends GitNameStatusEntry {
  oldMode: string
  newMode: string
}

/** Contract: diff --raw -z --no-abbrev --no-renames. */
export function parseGitRaw(bytes: Uint8Array): GitRawEntry[] {
  const parts = records(bytes)
  if (parts.length % 2) throw new GitInventoryError()
  const entries: GitRawEntry[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const match = parts[i].match(
      /^:(000000|100644|100755|120000|160000) (000000|100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([MADTUXB])$/
    )
    if (!match || match[3].length !== match[4].length) throw new GitInventoryError()
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      status: match[5],
      path: validateGitInventoryPath(parts[i + 1])
    })
  }
  return entries
}

export class GitInventoryError extends Error {
  constructor() {
    super('Unsupported or malformed Git inventory')
    this.name = 'GitInventoryError'
  }
}

function records(bytes: Uint8Array): string[] {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0) throw new GitInventoryError()
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .slice(0, -1)
      .split('\0')
  } catch {
    throw new GitInventoryError()
  }
}

// Lexical POSIX inventory paths only. Never normalize: the service must additionally
// enforce project containment and registry authority, including symlink boundaries.
export function validateGitInventoryPath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    path.includes('\0')
  )
    throw new GitInventoryError()
  return path
}

function fields(record: string, count: number): [string[], string] {
  const metadata: string[] = []
  let start = 0
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(' ', start)
    if (end < 0 || end === start) throw new GitInventoryError()
    metadata.push(record.slice(start, end))
    start = end + 1
  }
  return [metadata, validateGitInventoryPath(record.slice(start))]
}

/** Contract: porcelain v2 -z, --no-renames, --untracked-files=all.
 * Rename/copy type 2 is deliberately rejected; never interpret its second NUL as an entry.
 */
export function parseGitStatus(bytes: Uint8Array): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const record of records(bytes)) {
    if (/^# [^\s]+ .*$/.test(record)) continue
    if (record.startsWith('? ')) {
      const directory = record.endsWith('/')
      entries.push({
        kind: 'untracked',
        path: validateGitInventoryPath(record.slice(2, directory ? -1 : undefined)),
        ...(directory ? { directory: true as const } : {})
      })
      continue
    }
    const conflict = record.startsWith('u ')
    if (!conflict && !record.startsWith('1 ')) throw new GitInventoryError()
    const [m, path] = fields(record, conflict ? 10 : 8)
    if (
      !(conflict ? /^(DD|AU|UD|UA|DU|AA|UU)$/ : /^[.MADT]{2}$/).test(m[1]) ||
      !/^(N\.\.\.|S[.C][.M][.U])$/.test(m[2])
    )
      throw new GitInventoryError()
    const modeEnd = conflict ? 7 : 6
    if (
      !m.slice(3, modeEnd).every((mode) => /^(000000|100644|100755|120000|160000)$/.test(mode)) ||
      !m.slice(modeEnd).every((hash) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) ||
      new Set(m.slice(modeEnd).map((hash) => hash.length)).size !== 1
    )
      throw new GitInventoryError()
    const common = { path, indexStatus: m[1][0], worktreeStatus: m[1][1], submodule: m[2] }
    entries.push(
      conflict
        ? {
            ...common,
            kind: 'conflict',
            baseMode: m[3],
            oursMode: m[4],
            theirsMode: m[5],
            worktreeMode: m[6]
          }
        : { ...common, kind: 'tracked', headMode: m[3], indexMode: m[4], worktreeMode: m[5] }
    )
  }
  return entries
}

/** Contract: diff --name-status -z --no-renames. No paths come from patch headers. */
export function parseGitNameStatus(bytes: Uint8Array): GitNameStatusEntry[] {
  const parts = records(bytes)
  const entries: GitNameStatusEntry[] = []
  if (parts.length % 2 !== 0) throw new GitInventoryError()
  for (let i = 0; i < parts.length; i += 2) {
    if (!/^[MADTUXB]$/.test(parts[i])) throw new GitInventoryError()
    entries.push({ status: parts[i], path: validateGitInventoryPath(parts[i + 1]) })
  }
  return entries
}
