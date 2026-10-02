/**
 * Plugins written in the common `manifest.json` format.
 *
 * `normalizeManifestJson` rewrites those fields into this host's manifest shape before schema
 * validation, and reports what it had to drop so settings can show it.
 */

/** The common file name. Ours (`pi-desktop.json`) wins when a plugin ships both. */
export const MANIFEST_JSON_FILE = 'manifest.json'

/** `manifest.json` permission names → ours. Names that already match are left alone. */
export const PERMISSION_ALIASES: Readonly<Record<string, string>> = {
  'agent.tool.register': 'agent.tools',
  'agent.prompt.inject': 'agent.skills',
  'mcp.server.local': 'mcp.local',
  'mcp.server.remote': 'mcp.remote',
  'ui.panel': 'ui.view'
}

export function normalizePermissions(permissions: readonly string[]): string[] {
  return [...new Set(permissions.map((permission) => PERMISSION_ALIASES[permission] ?? permission))]
}

/** Top-level fields that only describe the plugin or tune features we do not have. */
const IGNORED_TOP_LEVEL = [
  'author',
  'homepage',
  'repository',
  'icon',
  'i18n',
  'enabledByDefault',
  'activationEvents',
  'fs',
  'net'
] as const

/** `manifest.json` contribution points this host does not implement. */
const UNSUPPORTED_CONTRIBUTIONS: Readonly<Record<string, string>> = {
  scenicThemes: '场景主题',
  windowAppearance: '窗口外观',
  services: '常驻服务',
  bus: '消息总线',
  agentExtensions: 'Agent 扩展模块',
  providers: '模型提供方',
  sessionSources: '外部会话来源',
  globalShortcuts: '全局快捷键'
}

/** Setting references in MCP env/headers become placeholders resolved from plugin settings. */
export function settingPlaceholder(key: string): string {
  return `\${setting:${key}}`
}

export function resolveSettingPlaceholders(
  value: string,
  settings: Readonly<Record<string, unknown>>
): string {
  return value.replace(/\$\{setting:([^}]+)\}/g, (_match, key: string) => {
    const setting = settings[key]
    return setting === undefined || setting === null ? '' : String(setting)
  })
}

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const without = (value: Json, keys: readonly string[]): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

function settingValues(values: unknown): unknown {
  if (!isRecord(values)) return values
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      isRecord(value) && typeof value.setting === 'string'
        ? settingPlaceholder(value.setting)
        : value
    ])
  )
}

/** A stdio command that is a plugin-relative path runs from the plugin directory. */
function pluginRelativeCommand(command: unknown): unknown {
  if (typeof command !== 'string') return command
  const relative = command.startsWith('./') ? command.slice(2) : command
  return relative.includes('/') && !relative.startsWith('/') && !relative.startsWith('${')
    ? `\${pluginRoot}/${relative}`
    : command
}

function normalizeMcpServers(servers: unknown): unknown {
  if (!Array.isArray(servers)) return servers
  return Object.fromEntries(
    servers.filter(isRecord).map((server) => {
      const rest = without(server, ['id', 'label', 'description', 'transport'])
      return [
        server.id,
        {
          ...rest,
          ...(rest.command === undefined ? {} : { command: pluginRelativeCommand(rest.command) }),
          ...(rest.env === undefined ? {} : { env: settingValues(rest.env) }),
          ...(rest.headers === undefined ? {} : { headers: settingValues(rest.headers) })
        }
      ]
    })
  )
}

export function normalizeManifestJson(
  raw: unknown,
  options: { piDesktopFile: boolean } = { piDesktopFile: true }
): { value: unknown; warnings: string[] } {
  if (!isRecord(raw)) return { value: raw, warnings: [] }
  const warnings: string[] = []
  const manifest: Json = { ...raw }

  for (const field of IGNORED_TOP_LEVEL) delete manifest[field]
  if (manifest.engines === undefined) manifest.engines = { piDesktop: '*' }
  if (Array.isArray(manifest.permissions))
    manifest.permissions = normalizePermissions(
      manifest.permissions.filter(
        (permission): permission is string => typeof permission === 'string'
      )
    )

  const contributes: Json = isRecord(manifest.contributes) ? { ...manifest.contributes } : {}
  for (const [field, label] of Object.entries(UNSUPPORTED_CONTRIBUTIONS)) {
    if (contributes[field] === undefined) continue
    delete contributes[field]
    warnings.push(`本版本不支持插件的${label}（contributes.${field}），已忽略。`)
  }

  // A `manifest.json` floating panel opens here as a view in the work panel.
  if (isRecord(manifest.ui)) {
    const ui = manifest.ui
    delete manifest.ui
    if (typeof ui.panel === 'string') {
      const views = Array.isArray(contributes.views) ? [...contributes.views] : []
      if (!views.some((view) => isRecord(view) && view.id === 'panel'))
        views.push({
          id: 'panel',
          title: ui.title ?? manifest.name ?? 'Panel',
          icon: 'plugin',
          entry: ui.panel,
          activation: 'onApp'
        })
      contributes.views = views
      warnings.push('插件面板在工作台中以视图显示，而不是独立窗口。')
    }
  }

  // `manifest.json` views are offered without an open project; our own default is onProject.
  if (options.piDesktopFile && Array.isArray(contributes.views))
    contributes.views = contributes.views.map((view) =>
      isRecord(view) && view.activation === undefined ? { ...view, activation: 'onApp' } : view
    )
  if (Array.isArray(contributes.commands))
    contributes.commands = contributes.commands.map((command) =>
      isRecord(command) ? without(command, ['category']) : command
    )
  if (Array.isArray(contributes.agentTools))
    contributes.agentTools = contributes.agentTools.map((tool) => {
      if (!isRecord(tool)) return tool
      const rest = without(tool, ['schema', 'risk', 'planSafeActions'])
      return tool.schema === undefined || rest.parameters !== undefined
        ? rest
        : { ...rest, parameters: tool.schema }
    })
  if (Array.isArray(contributes.skills))
    contributes.skills = contributes.skills.map((skill) =>
      isRecord(skill) && typeof skill.path === 'string' ? skill.path : skill
    )
  if (contributes.mcpServers !== undefined)
    contributes.mcpServers = normalizeMcpServers(contributes.mcpServers)
  if (Array.isArray(contributes.settings))
    contributes.settings = contributes.settings.map((setting) => {
      if (!isRecord(setting)) return setting
      const { key, title, description, type, default: fallback, options } = setting
      return {
        key,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        type,
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(options === undefined ? {} : { options })
      }
    })

  manifest.contributes = contributes
  return { value: manifest, warnings }
}
