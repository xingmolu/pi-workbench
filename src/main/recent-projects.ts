/** Only confirmed project opens are passed as newest; discovery never writes preferences. */
export function mergeRecentProjects(previous: unknown, newest?: string): string[] {
  return [
    ...new Set(
      [...(newest ? [newest] : []), ...(Array.isArray(previous) ? previous : [])].filter(
        (path): path is string => typeof path === 'string' && path.startsWith('/')
      )
    )
  ].slice(0, 100)
}
