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
import type { PermissionMode } from '../shared/contracts'
import {
  EMPTY_PERMISSION_RULES,
  autoApprovesCommand,
  commandMatchesRule,
  permissionRulesSchema,
  type PermissionRules
} from '../shared/permission-rules'
import { resolveToolPath } from './checkpoints'

/** Per-project allow rules, owned by the Host so the Renderer can only request changes.
 * Stored outside the project so they never end up in a repository. */
export class PermissionRulesStore {
  /** Every session worker has its own store; the file stamp keeps them in agreement. */
  private cache: {
    stamp: string
    rules: Record<string, PermissionRules>
    modes: Record<string, PermissionMode>
  } | null = null

  constructor(private readonly file: string) {}

  get(projectPath: string): PermissionRules {
    return this.read().rules[projectPath] ?? EMPTY_PERMISSION_RULES
  }

  /** The project's remembered approval level; new projects start by asking. */
  mode(projectPath: string): PermissionMode {
    return this.read().modes[projectPath] ?? 'ask'
  }

  setMode(projectPath: string, mode: PermissionMode): void {
    const { rules, modes } = this.read()
    const next = { ...modes }
    if (mode === 'ask') delete next[projectPath]
    else next[projectPath] = mode
    this.write(rules, next)
  }

  set(projectPath: string, rules: PermissionRules): PermissionRules {
    const parsed = permissionRulesSchema.parse(rules)
    const next = {
      commands: [...new Set(parsed.commands.map((rule) => rule.trim()))],
      projectEdits: parsed.projectEdits
    }
    const stored = this.read()
    const all = { ...stored.rules }
    if (!next.commands.length && !next.projectEdits) delete all[projectPath]
    else all[projectPath] = next
    this.write(all, stored.modes)
    return next
  }

  private write(
    projects: Record<string, PermissionRules>,
    modes: Record<string, PermissionMode>
  ): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ projects, modes }, null, 2), {
        mode: 0o600,
        flag: 'wx'
      })
      renameSync(temporary, this.file)
    } finally {
      rmSync(temporary, { force: true })
    }
    this.cache = null
  }

  /** Whether a tool call may skip confirmation under the project's rules, or under the
   * "帮我批准" level when `auto` is set. */
  allows(
    projectPath: string,
    toolName: string,
    input: unknown,
    cwd: string,
    auto = false
  ): boolean {
    const rules = this.get(projectPath)
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    if (toolName === 'bash') {
      const command = args.command
      return (
        typeof command === 'string' &&
        ((auto && autoApprovesCommand(command)) ||
          rules.commands.some((rule) => commandMatchesRule(command, rule)))
      )
    }
    if (toolName === 'powershell') {
      const command = args.command
      return (
        typeof command === 'string' &&
        rules.commands.some((rule) => commandMatchesRule(command, rule))
      )
    }
    if (toolName === 'write' || toolName === 'edit') {
      const path = args.path
      return (
        (auto || rules.projectEdits) &&
        typeof path === 'string' &&
        isInside(resolveToolPath(path, cwd), projectPath)
      )
    }
    return false
  }

  private read(): {
    rules: Record<string, PermissionRules>
    modes: Record<string, PermissionMode>
  } {
    const stamp = this.stamp()
    if (this.cache?.stamp === stamp) return this.cache
    const rules: Record<string, PermissionRules> = {}
    const modes: Record<string, PermissionMode> = {}
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        projects?: unknown
        modes?: unknown
      } | null
      if (parsed?.projects && typeof parsed.projects === 'object')
        for (const [path, value] of Object.entries(parsed.projects)) {
          const entry = permissionRulesSchema.safeParse(value)
          // A malformed entry grants nothing rather than failing open.
          if (entry.success) rules[path] = entry.data
        }
      if (parsed?.modes && typeof parsed.modes === 'object')
        for (const [path, value] of Object.entries(parsed.modes))
          if (value === 'auto' || value === 'open') modes[path] = value
    } catch {
      /* Missing or unreadable: no rules, ask for everything. */
    }
    this.cache = { stamp, rules, modes }
    return this.cache
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
