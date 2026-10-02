import { posix, win32 } from 'node:path'

/** Only confirmed project opens are passed as newest; discovery never writes preferences. */
export function mergeRecentProjects(
  previous: unknown,
  newest?: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const isAbsolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute
  return [
    ...new Set(
      [...(newest ? [newest] : []), ...(Array.isArray(previous) ? previous : [])].filter(
        (path): path is string => typeof path === 'string' && isAbsolute(path)
      )
    )
  ].slice(0, 100)
}
