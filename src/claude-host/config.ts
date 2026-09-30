import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ClaudeStorage } from './storage'
const configSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional()
  })
  .strict()
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
  config: ClaudeConfig,
  parent = process.env
): Record<string, string | undefined> {
  const env = { ...parent }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$)/.test(key)) delete env[key]
  }
  env.CLAUDE_CONFIG_DIR = storage.config
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '1'
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl
  return env
}
