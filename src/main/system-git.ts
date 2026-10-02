import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export type SystemGit = {
  /** Absolute path of the Git the host runs; never looked up on the user's PATH. */
  path: string
  /** PATH, plus on Windows the variables Git for Windows needs to start, for a minimal env. */
  env: NodeJS.ProcessEnv
}

/**
 * The Git the host trusts. It is a fixed system location rather than whatever PATH finds first,
 * so a project cannot put its own `git` in front of it. On Windows that is a standard Git for
 * Windows install (machine-wide first, then per-user); when none exists the default path is
 * still returned and running it fails with ENOENT, which callers already report.
 */
export function systemGit(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): SystemGit {
  if (platform !== 'win32') return { path: '/usr/bin/git', env: { PATH: '/usr/bin:/bin' } }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const roots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')
  ].filter((root): root is string => Boolean(root) && win32.isAbsolute(root!))
  const candidates = [...roots, 'C:\\Program Files'].map((root) =>
    win32.join(root, 'Git', 'cmd', 'git.exe')
  )
  const path = candidates.find((candidate) => exists(candidate)) ?? candidates.at(-1)!
  return {
    path,
    env: {
      PATH: [win32.dirname(path), win32.join(systemRoot, 'System32'), systemRoot].join(';'),
      SystemRoot: systemRoot
    }
  }
}

/** The null device, for GIT_CONFIG_GLOBAL and friends. */
export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
