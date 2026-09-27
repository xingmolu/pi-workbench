import { z } from 'zod'

/** Shell syntax that can chain, redirect, substitute or background another command. */
const COMPOUND = /[;&|`<>()$\n\r\\]/

const ruleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((rule) => !COMPOUND.test(rule), '规则不能包含 ; & | ` < > ( ) $ \\ 或换行')

export const permissionRulesSchema = z
  .object({
    /** Command prefixes Pi may run without asking, matched on whole words. */
    commands: z.array(ruleSchema).max(100),
    /** write/edit inside the project run without asking; each turn stays undoable. */
    projectEdits: z.boolean()
  })
  .strict()
export type PermissionRules = z.infer<typeof permissionRulesSchema>

export const EMPTY_PERMISSION_RULES: PermissionRules = { commands: [], projectEdits: false }

export const permissionRulesCommandSchema = z
  .object({
    type: z.literal('permission:rules:set'),
    /** The project these rules were edited for; rejected if the Host moved on. */
    projectPath: z.string().min(1),
    rules: permissionRulesSchema
  })
  .strict()
export type PermissionRulesCommand = z.infer<typeof permissionRulesCommandSchema>

function normalize(command: string): string {
  return command.trim().replace(/[ \t]+/g, ' ')
}

export function isCompoundCommand(command: string): boolean {
  return COMPOUND.test(command.trim())
}

/** Whole-word prefix match. Compound commands never match, so `npm test && rm -rf x`
 * cannot ride on an `npm test` rule. */
export function commandMatchesRule(command: string, rule: string): boolean {
  if (isCompoundCommand(command)) return false
  const text = normalize(command)
  const prefix = normalize(rule)
  return Boolean(prefix) && (text === prefix || text.startsWith(`${prefix} `))
}

/** Programs whose first word alone would allow arbitrary actions. */
const NO_SUGGESTION = new Set([
  'bash',
  'chmod',
  'chown',
  'curl',
  'dd',
  'env',
  'eval',
  'exec',
  'kill',
  'killall',
  'mkfs',
  'node',
  'perl',
  'python',
  'python3',
  'reboot',
  'rm',
  'rmdir',
  'ruby',
  'scp',
  'sh',
  'shutdown',
  'ssh',
  'su',
  'sudo',
  'wget',
  'xargs',
  'zsh',
  'deno',
  'bun',
  'npx',
  'pwsh',
  'powershell'
])

/** A reusable rule for an approved command: the program plus its subcommand, e.g.
 * `npm test`, `git status`. `null` when a rule would be unsafe or meaningless. */
export function suggestCommandRule(command: string): string | null {
  if (isCompoundCommand(command)) return null
  const [program, sub] = normalize(command).split(' ')
  if (!program || NO_SUGGESTION.has(program.replace(/^.*\//, ''))) return null
  return sub && /^[a-z][a-z0-9:._-]*$/.test(sub) ? `${program} ${sub}` : program
}
