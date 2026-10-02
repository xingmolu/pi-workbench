import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { piPackageRootsMessageSchema } from '../shared/workbench-host-schemas'
import { t } from '../shared/i18n'

export type ActiveHostIdentity = {
  sessionId: string | null
  generation: number
}

export type PiPackageRootsRouterDependencies = {
  readActiveIdentity(): ActiveHostIdentity
  setPackageRoots(roots: readonly PiPackageRoot[]): void | Promise<unknown>
  warn(message: string): void
  accepting?: boolean
}

export type WorkbenchPackageRootsHost = {
  setPackageRoots(roots: readonly PiPackageRoot[]): void | Promise<unknown>
}

export type PiPackageRootsLifecycleDependencies = {
  initialIdentity: ActiveHostIdentity
  warn(message: string): void
}

function sameIdentity(left: ActiveHostIdentity, right: ActiveHostIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation
}

function replaceRoots(
  host: WorkbenchPackageRootsHost | null,
  roots: readonly PiPackageRoot[],
  warn: (message: string) => void
): void {
  if (!host) return
  try {
    void Promise.resolve(host.setPackageRoots(roots)).catch(() => {
      warn(t('无法更新 Workbench package roots'))
    })
  } catch {
    warn(t('无法更新 Workbench package roots'))
  }
}

export function createPiPackageRootsLifecycle(dependencies: PiPackageRootsLifecycleDependencies): {
  hostStarted(): void
  hostExited(): void
  attachHost(host: WorkbenchPackageRootsHost): void
  detachHost(host: WorkbenchPackageRootsHost): void
  transitionIdentity(next: ActiveHostIdentity, applyContext: () => void): void
  handleMessage(message: unknown): boolean
} {
  let activeIdentity = { ...dependencies.initialIdentity }
  let host: WorkbenchPackageRootsHost | null = null
  let hostRunning = false
  let cachedRoots: { identity: ActiveHostIdentity; roots: PiPackageRoot[] } | null = null

  return {
    hostStarted() {
      if (hostRunning) return
      hostRunning = true
      cachedRoots = null
    },
    hostExited() {
      if (!hostRunning) return
      hostRunning = false
      cachedRoots = null
      replaceRoots(host, [], dependencies.warn)
    },
    attachHost(nextHost) {
      host = nextHost
      if (hostRunning && cachedRoots && sameIdentity(cachedRoots.identity, activeIdentity)) {
        replaceRoots(host, cachedRoots.roots, dependencies.warn)
      }
    },
    detachHost(detachedHost) {
      if (host === detachedHost) host = null
    },
    transitionIdentity(next, applyContext) {
      if (!sameIdentity(activeIdentity, next)) {
        cachedRoots = null
        replaceRoots(host, [], dependencies.warn)
        activeIdentity = { ...next }
      }
      applyContext()
    },
    handleMessage(message) {
      return routePiPackageRootsMessage(message, {
        readActiveIdentity: () => activeIdentity,
        accepting: hostRunning,
        setPackageRoots: (roots) => {
          const copiedRoots = roots.map((root) => ({ ...root }))
          // Sessions republish their roots on every refresh. Reloading an unchanged set would
          // tear down open panels and restart plugin processes in the middle of a turn.
          if (
            cachedRoots &&
            sameIdentity(cachedRoots.identity, activeIdentity) &&
            JSON.stringify(cachedRoots.roots) === JSON.stringify(copiedRoots)
          )
            return
          cachedRoots = { identity: { ...activeIdentity }, roots: copiedRoots }
          replaceRoots(host, copiedRoots, dependencies.warn)
        },
        warn: dependencies.warn
      })
    }
  }
}

function isPackageRootsCandidate(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'desktop-plugin-roots'
  )
}

export function routePiPackageRootsMessage(
  message: unknown,
  dependencies: PiPackageRootsRouterDependencies
): boolean {
  const parsed = piPackageRootsMessageSchema.safeParse(message)
  if (!parsed.success) {
    if (!isPackageRootsCandidate(message)) return false
    dependencies.warn(t('忽略无效的 Pi package roots 消息'))
    return true
  }

  if (dependencies.accepting === false) {
    dependencies.warn(t('忽略过期的 Pi package roots 消息'))
    return true
  }

  const activeIdentity = dependencies.readActiveIdentity()
  if (
    parsed.data.sessionId !== activeIdentity.sessionId ||
    parsed.data.generation !== activeIdentity.generation
  ) {
    dependencies.warn(t('忽略过期的 Pi package roots 消息'))
    return true
  }

  try {
    void Promise.resolve(dependencies.setPackageRoots(parsed.data.roots)).catch(() => {
      dependencies.warn(t('无法更新 Workbench package roots'))
    })
  } catch {
    dependencies.warn(t('无法更新 Workbench package roots'))
  }
  return true
}
