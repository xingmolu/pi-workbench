import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  EMPTY_PERMISSION_RULES,
  commandMatchesRule,
  permissionRulesSchema,
  type PermissionRules
} from '../shared/permission-rules'
import { resolveToolPath } from './checkpoints'

/** Per-project allow rules, owned by the Host so the Renderer can only request changes.
 * Stored outside the project so they never end up in a repository. */
export class PermissionRulesStore {
  /** Every session worker has its own store; the file stamp keeps them in agreement. */
  private cache: { stamp: string; rules: Record<string, PermissionRules> } | null = null

  constructor(private readonly file: string) {}

  get(projectPath: string): PermissionRules {
    return this.read()[projectPath] ?? EMPTY_PERMISSION_RULES
  }

  set(projectPath: string, rules: PermissionRules): PermissionRules {
    const parsed = permissionRulesSchema.parse(rules)
    const next = {
      commands: [...new Set(parsed.commands.map((rule) => rule.trim()))],
      projectEdits: parsed.projectEdits
    }
    const all = { ...this.read() }
    if (!next.commands.length && !next.projectEdits) delete all[projectPath]
    else all[projectPath] = next
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ projects: all }, null, 2), {
        mode: 0o600,
        flag: 'wx'
      })
      renameSync(temporary, this.file)
    } finally {
      rmSync(temporary, { force: true })
    }
    this.cache = null
    return next
  }

  /** Whether a tool call may skip confirmation under the project's rules. */
  allows(projectPath: string, toolName: string, input: unknown, cwd: string): boolean {
    const rules = this.get(projectPath)
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    if (toolName === 'bash' || toolName === 'powershell') {
      const command = args.command
      return (
        typeof command === 'string' &&
        rules.commands.some((rule) => commandMatchesRule(command, rule))
      )
    }
    if (toolName === 'write' || toolName === 'edit') {
      const path = args.path
      return (
        rules.projectEdits &&
        typeof path === 'string' &&
        isInside(resolveToolPath(path, cwd), projectPath)
      )
    }
    return false
  }

  private read(): Record<string, PermissionRules> {
    const stamp = this.stamp()
    if (this.cache?.stamp === stamp) return this.cache.rules
    const all: Record<string, PermissionRules> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const projects =
        parsed && typeof parsed === 'object' ? (parsed as { projects?: unknown }).projects : null
      if (projects && typeof projects === 'object')
        for (const [path, value] of Object.entries(projects)) {
          const rules = permissionRulesSchema.safeParse(value)
          // A malformed entry grants nothing rather than failing open.
          if (rules.success) all[path] = rules.data
        }
    } catch {
      /* Missing or unreadable: no rules. */
    }
    this.cache = { stamp, rules: all }
    return all
  }

  private stamp(): string {
    try {
      const stat = statSync(this.file)
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    } catch {
      return 'missing'
    }
  }
}

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
