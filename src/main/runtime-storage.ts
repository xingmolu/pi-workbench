import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { runtimeIdSchema } from '../shared/agent-runtime'

export type RuntimeStoragePaths = Readonly<{
  root: string
  config: string
  sessions: string
  state: string
  cache: string
}>

/** Every new adapter gets app-owned storage, independent of a CLI's home-directory conventions. */
export function runtimeStoragePaths(dataRoot: string, runtimeId: string): RuntimeStoragePaths {
  if (!isAbsolute(dataRoot)) throw new Error('Runtime data root must be absolute')
  const root = join(dataRoot, 'runtimes', runtimeIdSchema.parse(runtimeId))
  return {
    root,
    config: join(root, 'config'),
    sessions: join(root, 'sessions'),
    state: join(root, 'state'),
    cache: join(root, 'cache')
  }
}

export async function prepareRuntimeStorage(paths: RuntimeStoragePaths): Promise<void> {
  await Promise.all(
    [paths.config, paths.sessions, paths.state, paths.cache].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 })
    )
  )
}
