import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'

export type MergeWorkbenchPackageRootsOptions = {
  canonicalize?: (path: string) => Promise<string>
}

const SAFE_SOURCE_ORDER = ['本机插件', 'Pi 用户包', 'Pi 项目包', '来源已隐藏'] as const
type SafeRootSource = (typeof SAFE_SOURCE_ORDER)[number]

type AggregatedRoot = {
  path: string
  sources: Set<SafeRootSource>
  scope: PiPackageRoot['scope']
  hasExecutablePiResources: boolean
}

function rendererSafeSource(source: string): SafeRootSource {
  return source === '本机插件' || source === 'Pi 用户包' || source === 'Pi 项目包'
    ? source
    : '来源已隐藏'
}

function aggregateSource(sources: ReadonlySet<SafeRootSource>): string {
  return SAFE_SOURCE_ORDER.filter((source) => sources.has(source)).join(' / ')
}

/**
 * Canonicalizes and merges trusted Main-side discovery roots before manifest discovery.
 * Source metadata is reduced to a small host-owned allowlist because it is later shown
 * in the renderer; caller-provided paths and loader source strings never pass through.
 */
export async function mergeWorkbenchPackageRoots(
  roots: readonly PiPackageRoot[],
  options: MergeWorkbenchPackageRootsOptions = {}
): Promise<PiPackageRoot[]> {
  const canonicalize = options.canonicalize ?? realpath
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        const canonicalPath = await canonicalize(root.path)
        if (isAbsolute(canonicalPath) && !canonicalPath.includes('\0')) {
          return { root, canonicalPath }
        }
      } catch {
        // Discovery owns the stable unavailable-root diagnostic.
      }
      return { root, canonicalPath: null }
    })
  )
  const merged = new Map<string, AggregatedRoot>()

  for (const candidate of canonicalRoots) {
    const { root, canonicalPath } = candidate
    const source = rendererSafeSource(root.source)
    const path = canonicalPath ?? root.path
    const mergeKey = canonicalPath ?? `unavailable\0${root.path}`
    const existing = merged.get(mergeKey)
    if (existing) {
      existing.sources.add(source)
      if (root.scope === 'project') existing.scope = 'project'
      if (root.hasExecutablePiResources) existing.hasExecutablePiResources = true
      continue
    }
    merged.set(mergeKey, {
      path,
      sources: new Set([source]),
      scope: root.scope,
      hasExecutablePiResources: root.hasExecutablePiResources
    })
  }

  return [...merged.values()]
    .map((root) => ({
      path: root.path,
      source: aggregateSource(root.sources),
      scope: root.scope,
      hasExecutablePiResources: root.hasExecutablePiResources
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}
