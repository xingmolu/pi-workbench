// i18n-ignore-file: loaded directly by Node in SDK tests, so it imports no runtime code from shared/.
import { isAbsolute, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

export function belongsToProject(sessionCwd: unknown, projectCwd: unknown): boolean {
  const canonical = (path: string): string => {
    try { return realpathSync(path) } catch { return resolve(path) }
  }
  return (
    typeof sessionCwd === 'string' &&
    typeof projectCwd === 'string' &&
    isAbsolute(sessionCwd) &&
    isAbsolute(projectCwd) &&
    canonical(sessionCwd) === canonical(projectCwd)
  )
}

export function filterProjectSessions<T extends { cwd?: string }>(
  sessions: T[],
  projectCwd: string
): T[] {
  return sessions.filter((session) => belongsToProject(session.cwd, projectCwd))
}

export function requireProjectSessionPath<T extends { cwd?: string; path: string }>(
  sessions: T[],
  projectCwd: string,
  path: string
): void {
  if (!filterProjectSessions(sessions, projectCwd).some((session) => session.path === path)) {
    throw new Error('会话不属于当前工作区')
  }
}

export function assertProjectSession(
  manager: Pick<SessionManager, 'getCwd'>,
  projectCwd: string,
  factoryCwd = projectCwd
): void {
  if (
    !belongsToProject(manager.getCwd(), projectCwd) ||
    !belongsToProject(factoryCwd, projectCwd)
  ) {
    throw new Error('会话不属于当前工作区')
  }
}

export async function listProjectSessions(
  manager: Pick<typeof SessionManager, 'list'>,
  projectCwd: string,
  sessionDir: string
) {
  return filterProjectSessions(await manager.list(projectCwd, sessionDir), projectCwd)
}

export async function continueProjectSession(
  manager: Pick<typeof SessionManager, 'list' | 'open' | 'create'>,
  projectCwd: string,
  sessionDir: string
): Promise<SessionManager> {
  const sessions = await listProjectSessions(manager, projectCwd, sessionDir)
  const session = sessions[0]
    ? manager.open(sessions[0].path, sessionDir)
    : manager.create(projectCwd, sessionDir)
  assertProjectSession(session, projectCwd)
  return session
}
