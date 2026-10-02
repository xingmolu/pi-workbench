import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Resolves symlinks on the deepest existing ancestor, so a link inside the project that
 * points elsewhere does not count as a project file. */
function realish(path: string): string {
  let current = path
  const rest: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return path
    rest.unshift(current.slice(parent.length + 1))
    current = parent
  }
  try {
    return resolve(realpathSync(current), ...rest)
  } catch {
    return path
  }
}

export function isInside(path: string, root: string): boolean {
  const target = realish(path)
  const base = realish(root)
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
