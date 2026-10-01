import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ClaudeStorage } from './storage'
/** A Claude subscription login kept in its own configuration home under `accounts/<id>`. */
const accountSchema = z
  .object({
    id: z.string().regex(/^claude-[a-z0-9]{6,16}$/),
    email: z.string().max(254).optional(),
    plan: z.string().max(40).optional()
  })
  .strict()
/** An Anthropic-compatible API connection; it shares the default configuration home. */
const apiSchema = z
  .object({
    id: z.string().regex(/^claude-api-[a-z0-9]{6,16}$/),
    label: z.string().max(80).optional(),
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional()
  })
  .strict()
const configSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /** Email of the login in the default configuration home, learned from the SDK. */
    email: z.string().max(254).optional(),
    plan: z.string().max(40).optional(),
    accounts: z.array(accountSchema).max(32).optional(),
    apis: z.array(apiSchema).max(32).optional(),
    /** Connection new queries use: `anthropic` (default home) or an account/API id. */
    active: z.string().max(40).optional()
  })
  .strict()
export type ClaudeAccountConfig = z.infer<typeof accountSchema>
export type ClaudeApiConfig = z.infer<typeof apiSchema>
export type ClaudeConfig = z.infer<typeof configSchema>
export function bundledClaudeExecutable(): string {
  const require = createRequire(import.meta.url)
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const packagePath = require.resolve(
    `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}/package.json`
  )
  return join(
    dirname(packagePath).replace('app.asar/', 'app.asar.unpacked/'),
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  )
}
export async function readConfig(storage: ClaudeStorage): Promise<ClaudeConfig> {
  try {
    return configSchema.parse(
      JSON.parse(await readFile(join(storage.config, 'desktop.json'), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}
export async function saveConfig(storage: ClaudeStorage, config: ClaudeConfig): Promise<void> {
  await mkdir(storage.config, { recursive: true })
  const path = join(storage.config, 'desktop.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(configSchema.parse(config), null, 2), { mode: 0o600 })
  await rename(temporary, path)
}
/** Remove inherited provider credentials, CLI overrides and auth helpers before SDK startup. */
export function claudeEnvironment(
  storage: ClaudeStorage,
  config: Pick<ClaudeConfig, 'apiKey' | 'baseUrl'>,
  parent = process.env,
  configHome = storage.config
): Record<string, string | undefined> {
  const env = { ...parent }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$)/.test(key)) delete env[key]
  }
  env.CLAUDE_CONFIG_DIR = configHome
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '1'
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl
  return env
}
