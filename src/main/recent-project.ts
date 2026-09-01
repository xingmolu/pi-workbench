import { realpath, stat } from 'node:fs/promises'
import type { AgentSnapshot } from '../shared/contracts'

export async function resolveExistingProjectPath(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const canonicalPath = await realpath(value)
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : null
  } catch {
    return null
  }
}

export function pathToPersistAfterOpen(
  canonicalPath: string,
  snapshot: Pick<AgentSnapshot, 'project'>
): string | null {
  return snapshot.project?.path === canonicalPath ? canonicalPath : null
}
