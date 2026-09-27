import { constants as fileSystemConstants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import semver from 'semver'
import { z } from 'zod'
import type { WorkbenchContribution, WorkbenchDiagnostic } from '../shared/workbench-contracts'
import { workbenchActivationSchema, workbenchIconSchema } from '../shared/workbench-schemas'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'

export const MAX_WORKBENCH_MANIFEST_BYTES = 256 * 1024

class ManifestTooLargeError extends Error {}

export type ValidatedWorkbenchEntry = {
  contribution: WorkbenchContribution
  /**
   * Discovery-time snapshot only. The Task 3 host must re-run realpath, regular-file, and
   * canonical plugin-root containment checks before activation or loading.
   */
  canonicalEntryPath: string
}

export type ValidatedWorkbenchPlugin = {
  pluginId: string
  name: string
  version: string
  description?: string
  requestedPermissions: string[]
  source: string
  scope: PiPackageRoot['scope']
  hasExecutablePiResources: boolean
  canonicalRootPath: string
  manifestPath: string
  workbench: ValidatedWorkbenchEntry[]
  /** Discovery-time snapshot of the plugin process entry; revalidated before spawning. */
  canonicalMainPath?: string
  commands: ValidatedPluginCommand[]
}

export type ValidatedPluginCommand = { id: string; title: string; keywords: string[] }

export type WorkbenchManifestDiscovery = {
  plugins: ValidatedWorkbenchPlugin[]
  diagnostics: WorkbenchDiagnostic[]
}

export type WorkbenchManifestDiscoveryOptions = {
  roots: readonly PiPackageRoot[]
  appVersion: string
}

const namespacedIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(256)
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)+$/,
    'Expected a lowercase, namespaced identifier'
  )

const manifestWorkbenchEntrySchema = z
  .object({
    id: namespacedIdentifierSchema,
    title: z.string().trim().min(1).max(256),
    icon: workbenchIconSchema,
    activation: workbenchActivationSchema.default('onProject'),
    surface: z
      .object({
        kind: z.literal('sandboxed-web'),
        entry: z.string().min(1).max(4096)
      })
      .strict()
  })
  .strict()

const localIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/, 'Expected a lowercase local identifier')

/** `{ en, "zh-CN" }` titles as in the common manifest.json format manifest; the UI is Chinese-first. */
const localizedTitleSchema = z.union([
  z.string().trim().min(1).max(256),
  z
    .object({
      en: z.string().trim().min(1).max(256),
      'zh-CN': z.string().trim().min(1).max(256).optional()
    })
    .strict()
])
type LocalizedTitle = z.infer<typeof localizedTitleSchema>
function resolveTitle(title: LocalizedTitle): string {
  return typeof title === 'string' ? title : (title['zh-CN'] ?? title.en)
}

/** Icon tokens from the manifest.json vocabulary map onto the host's own icon set. */
function resolveIcon(token: string | undefined): WorkbenchContribution['icon'] {
  switch (token) {
    case 'files':
    case 'folder':
      return 'files'
    case 'diff':
    case 'pull-request':
    case 'git-review':
      return 'git-review'
    case 'branch':
    case 'git':
    case 'git-branch':
      return 'git-branch'
    case 'terminal':
      return 'terminal'
    case 'browser':
      return 'browser'
    case 'flask':
      return 'flask'
    default:
      return 'plugin'
  }
}

const manifestViewSchema = z
  .object({
    id: localIdentifierSchema,
    title: localizedTitleSchema,
    icon: z.string().max(64).optional(),
    entry: z.string().min(1).max(4096),
    order: z.number().int().min(0).max(10_000).optional(),
    activation: workbenchActivationSchema.default('onProject')
  })
  .strict()

const manifestCommandSchema = z
  .object({
    id: localIdentifierSchema,
    title: localizedTitleSchema,
    keywords: z.array(z.string().trim().min(1).max(64)).max(16).default([])
  })
  .strict()

const workbenchManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: namespacedIdentifierSchema,
    version: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(256),
    description: z.string().max(4096).optional(),
    engines: z.object({ piDesktop: z.string().trim().min(1).max(128) }).strict(),
    permissions: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
    main: z.string().min(1).max(4096).optional(),
    contributes: z
      .object({
        /** Legacy Pi Desktop form, still accepted. */
        workbench: z.array(manifestWorkbenchEntrySchema).max(256).default([]),
        views: z.array(manifestViewSchema).max(64).default([]),
        commands: z.array(manifestCommandSchema).max(128).default([])
      })
      .strict()
      .default({ workbench: [], views: [], commands: [] })
  })
  .strict()
  .refine((manifest) => manifest.main !== undefined || manifest.contributes.commands.length === 0, {
    message: 'Commands require a main entry'
  })

type WorkbenchManifest = z.infer<typeof workbenchManifestSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnosticPluginId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const pluginId = value.id.trim()
  return pluginId.length > 0 && pluginId.length <= 256 ? pluginId : undefined
}

/** Top-level `commands` was never a supported shape; commands live under `contributes`. */
function hasUnsupportedCommands(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'commands')
}

async function resolvePluginFile(
  canonicalRootPath: string,
  entry: string
): Promise<string | undefined> {
  if (!isLocalRelativeEntry(entry)) return undefined
  try {
    const candidate = await realpath(join(canonicalRootPath, entry))
    if (isPathWithinRoot(canonicalRootPath, candidate) && (await stat(candidate)).isFile())
      return candidate
  } catch {
    // Missing or unreadable files are reported by the caller.
  }
  return undefined
}

function isLocalRelativeEntry(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    return false
  }
  return value.split('/').every((segment) => segment !== '..')
}

function isPathWithinRoot(canonicalRootPath: string, canonicalEntryPath: string): boolean {
  const relativePath = relative(canonicalRootPath, canonicalEntryPath)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

/** Bundled roots are discovered first so a user plugin can never take a bundled plugin's id. */
function compareRoots(left: PiPackageRoot, right: PiPackageRoot): number {
  const bundled = Number(right.scope === 'bundled') - Number(left.scope === 'bundled')
  if (bundled !== 0) return bundled
  const leftKey = `${left.path}\0${left.scope}\0${left.source}\0${left.hasExecutablePiResources}`
  const rightKey = `${right.path}\0${right.scope}\0${right.source}\0${right.hasExecutablePiResources}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

async function readBoundedManifest(manifestPath: string): Promise<string> {
  const handle = await open(
    manifestPath,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NONBLOCK | fileSystemConstants.O_NOFOLLOW
  )
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error('Manifest is not a regular file')
    if (metadata.size > MAX_WORKBENCH_MANIFEST_BYTES) throw new ManifestTooLargeError()

    const buffer = Buffer.allocUnsafe(MAX_WORKBENCH_MANIFEST_BYTES + 1)
    let totalBytesRead = 0
    while (totalBytesRead < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead
      )
      if (bytesRead === 0) break
      totalBytesRead += bytesRead
    }
    if (totalBytesRead > MAX_WORKBENCH_MANIFEST_BYTES) throw new ManifestTooLargeError()
    return buffer.subarray(0, totalBytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function discoverWorkbenchManifests({
  roots,
  appVersion
}: WorkbenchManifestDiscoveryOptions): Promise<WorkbenchManifestDiscovery> {
  if (!semver.valid(appVersion)) throw new TypeError('appVersion must be a valid semantic version')

  const plugins: ValidatedWorkbenchPlugin[] = []
  const diagnostics: WorkbenchDiagnostic[] = []
  const pluginIds = new Set<string>()
  const viewIds = new Set<string>()
  for (const root of [...roots].sort(compareRoots)) {
    let canonicalRootPath: string
    try {
      canonicalRootPath = await realpath(root.path)
      if (!(await stat(canonicalRootPath)).isDirectory()) throw new Error('Root is not a directory')
    } catch {
      diagnostics.push({
        severity: 'error',
        code: 'root-unavailable',
        message: `Workbench plugin root from ${root.source} is unavailable.`
      })
      continue
    }

    let manifestPath: string
    let manifestText: string
    let declaredManifestExists = false
    try {
      const declaredManifestPath = join(canonicalRootPath, 'pi-desktop.json')
      await lstat(declaredManifestPath)
      declaredManifestExists = true
      manifestPath = await realpath(declaredManifestPath)
      if (!isPathWithinRoot(canonicalRootPath, manifestPath)) {
        throw new Error('Manifest is not a regular file inside its plugin root')
      }
      manifestText = await readBoundedManifest(manifestPath)
    } catch (error) {
      if (error instanceof ManifestTooLargeError) {
        diagnostics.push({
          severity: 'error',
          code: 'manifest-too-large',
          message: 'Workbench manifest exceeds the supported size limit.'
        })
        continue
      }
      // A package without a desktop manifest is not a broken desktop plugin.
      if (!declaredManifestExists && isRecord(error) && error.code === 'ENOENT') continue
      diagnostics.push({
        severity: 'error',
        code: 'manifest-read-failed',
        message: `Workbench manifest from ${root.source} could not be read.`
      })
      continue
    }

    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(manifestText)
    } catch {
      diagnostics.push({
        severity: 'error',
        code: 'manifest-invalid-json',
        message: `Workbench manifest from ${root.source} is not valid JSON.`
      })
      continue
    }
    const pluginId = diagnosticPluginId(rawManifest)

    if (hasUnsupportedCommands(rawManifest)) {
      diagnostics.push({
        severity: 'error',
        code: 'commands-not-supported',
        message: 'Workbench commands are not supported.',
        ...(pluginId === undefined ? {} : { pluginId })
      })
      continue
    }

    const parsedManifest = workbenchManifestSchema.safeParse(rawManifest)
    if (!parsedManifest.success) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest-invalid',
        message: 'Workbench manifest does not match the supported schema.',
        ...(pluginId === undefined ? {} : { pluginId })
      })
      continue
    }
    const manifest: WorkbenchManifest = parsedManifest.data

    if (!semver.valid(manifest.version)) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest-invalid',
        message: 'Workbench plugin version must be a valid semantic version.',
        pluginId: manifest.id
      })
      continue
    }

    if (!semver.validRange(manifest.engines.piDesktop)) {
      diagnostics.push({
        severity: 'error',
        code: 'engine-invalid',
        message: 'Workbench plugin engine must be a valid semantic version range.',
        pluginId: manifest.id
      })
      continue
    }

    if (!semver.satisfies(appVersion, manifest.engines.piDesktop)) {
      diagnostics.push({
        severity: 'error',
        code: 'engine-incompatible',
        message: `Workbench plugin does not support Pi Desktop ${appVersion}.`,
        pluginId: manifest.id
      })
      continue
    }

    if (pluginIds.has(manifest.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-plugin-id',
        message: 'Workbench plugin id is already registered.',
        pluginId: manifest.id
      })
      continue
    }

    const workbench: ValidatedWorkbenchEntry[] = []
    let invalidEntry = false
    for (const entry of manifest.contributes.workbench) {
      let canonicalEntryPath: string | undefined
      if (isLocalRelativeEntry(entry.surface.entry)) {
        try {
          const candidate = await realpath(join(canonicalRootPath, entry.surface.entry))
          if (isPathWithinRoot(canonicalRootPath, candidate) && (await stat(candidate)).isFile()) {
            canonicalEntryPath = candidate
          }
        } catch {
          // A missing or unreadable entry is reported like every other invalid entry.
        }
      }

      if (canonicalEntryPath === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'entry-invalid',
          message: 'Workbench entry must resolve to a regular file inside its plugin root.',
          pluginId: manifest.id,
          viewId: entry.id
        })
        invalidEntry = true
        break
      }

      workbench.push({
        contribution: {
          pluginId: manifest.id,
          viewId: entry.id,
          title: entry.title,
          icon: entry.icon,
          activation: entry.activation,
          surface: { kind: 'sandboxed-web' }
        },
        canonicalEntryPath
      })
    }
    for (const view of [...manifest.contributes.views].sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0)
    )) {
      const canonicalEntryPath = await resolvePluginFile(canonicalRootPath, view.entry)
      if (canonicalEntryPath === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'entry-invalid',
          message: 'Workbench entry must resolve to a regular file inside its plugin root.',
          pluginId: manifest.id,
          viewId: `${manifest.id}.${view.id}`
        })
        invalidEntry = true
        break
      }
      workbench.push({
        contribution: {
          pluginId: manifest.id,
          viewId: `${manifest.id}.${view.id}`,
          title: resolveTitle(view.title),
          icon: resolveIcon(view.icon),
          activation: view.activation,
          surface: { kind: 'sandboxed-web' }
        },
        canonicalEntryPath
      })
    }
    if (invalidEntry) continue

    let canonicalMainPath: string | undefined
    if (manifest.main !== undefined) {
      canonicalMainPath = await resolvePluginFile(canonicalRootPath, manifest.main)
      if (canonicalMainPath === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'main-invalid',
          message: 'Plugin main must resolve to a regular file inside its plugin root.',
          pluginId: manifest.id
        })
        continue
      }
    }

    // Unknown names stay visible in settings; the grant gateway only ever honors known ones.
    const requestedPermissions = [...new Set(manifest.permissions ?? [])]

    const currentViewIds = new Set<string>()
    const duplicateViewId = workbench.find(({ contribution }) => {
      if (viewIds.has(contribution.viewId) || currentViewIds.has(contribution.viewId)) return true
      currentViewIds.add(contribution.viewId)
      return false
    })?.contribution.viewId
    if (duplicateViewId !== undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-view-id',
        message: 'Workbench view id is already registered.',
        pluginId: manifest.id,
        viewId: duplicateViewId
      })
      continue
    }

    plugins.push({
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      requestedPermissions,
      source: root.source,
      scope: root.scope,
      hasExecutablePiResources: root.hasExecutablePiResources,
      canonicalRootPath,
      manifestPath,
      workbench,
      ...(canonicalMainPath === undefined ? {} : { canonicalMainPath }),
      commands: manifest.contributes.commands.map((command) => ({
        id: command.id,
        title: resolveTitle(command.title),
        keywords: command.keywords
      }))
    })
    pluginIds.add(manifest.id)
    currentViewIds.forEach((viewId) => viewIds.add(viewId))
  }

  return { plugins, diagnostics }
}
