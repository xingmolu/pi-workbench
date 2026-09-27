import type { ConversationNode, ToolFileChange } from '../../../shared/contracts'

export type TurnFileChange = {
  path: string
  additions: number
  deletions: number
  changes: ToolFileChange[]
}

/** Files changed by successful write/edit calls, in first-touched order. Failed, rejected
 * and unfinished calls are excluded: they are not evidence that the file changed. */
export function summarizeTurnChanges(nodes: readonly ConversationNode[]): TurnFileChange[] {
  const files = new Map<string, TurnFileChange>()
  for (const node of nodes) {
    if (node.type !== 'tool' || node.status !== 'success' || !node.change) continue
    const change = node.change
    const file = files.get(change.path) ?? {
      path: change.path,
      additions: 0,
      deletions: 0,
      changes: []
    }
    file.additions += change.additions
    file.deletions += change.deletions
    file.changes.push(change)
    files.set(change.path, file)
  }
  return [...files.values()]
}

function trimSlashes(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/** Project-relative when the path is inside the project; the file name is always last. */
export function displayChangePath(
  path: string,
  projectPath?: string
): { dir: string; name: string } {
  let relative = path
  const root = projectPath ? trimSlashes(projectPath) : ''
  if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)))
    relative = path.slice(root.length + 1)
  const cut = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\'))
  return cut < 0
    ? { dir: '', name: relative }
    : { dir: relative.slice(0, cut + 1), name: relative.slice(cut + 1) }
}
