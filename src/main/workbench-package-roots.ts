import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { piPackageRootsMessageSchema } from '../shared/workbench-host-schemas'

export type ActiveHostIdentity = {
  sessionId: string | null
  generation: number
}

export type PiPackageRootsRouterDependencies = {
  readActiveIdentity(): ActiveHostIdentity
  setPackageRoots(roots: readonly PiPackageRoot[]): void | Promise<unknown>
  warn(message: string): void
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
    dependencies.warn('忽略无效的 Pi package roots 消息')
    return true
  }

  const activeIdentity = dependencies.readActiveIdentity()
  if (
    parsed.data.sessionId !== activeIdentity.sessionId ||
    parsed.data.generation !== activeIdentity.generation
  ) {
    dependencies.warn('忽略过期的 Pi package roots 消息')
    return true
  }

  try {
    void Promise.resolve(dependencies.setPackageRoots(parsed.data.roots)).catch(() => {
      dependencies.warn('无法更新 Workbench package roots')
    })
  } catch {
    dependencies.warn('无法更新 Workbench package roots')
  }
  return true
}
