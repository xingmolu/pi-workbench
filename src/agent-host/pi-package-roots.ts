import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { PiPackageRoot, PiPackageRootsMessage } from '../shared/workbench-host-contracts'

export type LoadedPiResource = {
  sourceInfo: {
    path: string
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin: 'package' | 'top-level'
    baseDir?: string
  }
}

export type LoadedPiResources = {
  extensions: readonly LoadedPiResource[]
  skills: readonly LoadedPiResource[]
}

export type CollectLoadedPiPackageRootsOptions = LoadedPiResources & {
  canonicalize?: (path: string) => Promise<string>
}

type AggregatedRoot = {
  path: string
  scope: 'user' | 'project'
  hasExecutablePiResources: boolean
}

export type PiPackageRootsPublication<Runtime> = {
  runtime: Runtime
  message: PiPackageRootsMessage
}

export type CurrentPackageRootsIdentity<Runtime> = {
  runtime: Runtime | null
  sessionId: string | null
  generation: number
}

function rendererSafePackageSource(scope: 'user' | 'project'): string {
  return scope === 'project' ? 'Pi 项目包' : 'Pi 用户包'
}

export async function collectLoadedPiPackageRoots(
  options: CollectLoadedPiPackageRootsOptions
): Promise<PiPackageRoot[]> {
  const canonicalize = options.canonicalize ?? realpath
  const candidates = [
    ...options.extensions.map((resource) => ({ resource, executable: true })),
    ...options.skills.map((resource) => ({ resource, executable: false }))
  ]
  const roots = new Map<string, AggregatedRoot>()

  await Promise.all(
    candidates.map(async ({ resource, executable }) => {
      const { sourceInfo } = resource
      const baseDir = sourceInfo.baseDir
      if (
        sourceInfo.origin !== 'package' ||
        (sourceInfo.scope !== 'user' && sourceInfo.scope !== 'project') ||
        !baseDir ||
        baseDir.includes('\0') ||
        !isAbsolute(baseDir)
      ) {
        return
      }

      let canonicalPath: string
      try {
        canonicalPath = await canonicalize(baseDir)
      } catch {
        return
      }
      if (!isAbsolute(canonicalPath) || canonicalPath.includes('\0')) return

      const existing = roots.get(canonicalPath)
      if (existing) {
        if (sourceInfo.scope === 'project') existing.scope = 'project'
        if (executable) existing.hasExecutablePiResources = true
        return
      }

      roots.set(canonicalPath, {
        path: canonicalPath,
        scope: sourceInfo.scope,
        hasExecutablePiResources: executable
      })
    })
  )

  return [...roots.values()]
    .map((root) => ({
      path: root.path,
      source: rendererSafePackageSource(root.scope),
      scope: root.scope,
      hasExecutablePiResources: root.hasExecutablePiResources
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function packageRootsMessageForSnapshot<Runtime>(
  publication: PiPackageRootsPublication<Runtime>,
  current: CurrentPackageRootsIdentity<Runtime>
): PiPackageRootsMessage | null {
  if (
    publication.runtime !== current.runtime ||
    publication.message.sessionId !== current.sessionId ||
    publication.message.generation !== current.generation
  ) {
    return null
  }
  return publication.message
}
