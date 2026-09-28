/** Shell choice and environment for user terminals. Pure, so Main and the host share it. */

const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const

const usable = (path: string | null | undefined): path is string =>
  typeof path === 'string' && path.startsWith('/') && !path.includes('\0')

/** The first absolute, executable shell of the user's choices, then zsh, bash and sh. */
export function resolveShell(
  preferred: readonly (string | null | undefined)[],
  isExecutable: (path: string) => boolean
): string {
  for (const candidate of [...preferred, ...FALLBACK_SHELLS])
    if (usable(candidate) && isExecutable(candidate)) return candidate
  return '/bin/sh'
}

export function shellName(shell: string): string {
  return (shell.split('/').pop() ?? shell).replace(/^-/, '')
}

/**
 * A login shell for real use. The isolated E2E fixture skips every startup file instead, in
 * whichever syntax the shell understands.
 */
export function shellArgs(shell: string, isolated: boolean): string[] {
  const name = shellName(shell)
  if (!isolated) return ['-l']
  if (name === 'zsh') return ['-f']
  if (name === 'bash') return ['--noprofile', '--norc']
  return []
}

/** Variables of the app's own runtime that must not leak into the user's shell. */
const INTERNAL =
  /^(ELECTRON_|PI_DESKTOP_|VITE_|npm_|CHROME_)|^(NODE_OPTIONS|INIT_CWD|ORIGINAL_XDG_CURRENT_DESKTOP)$/

/** Tool directories a GUI launch often lacks; the login shell's own profile still wins. */
const LEADING_PATHS = ['/opt/homebrew/bin', '/usr/local/bin']
const TRAILING_PATHS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * The user's environment minus the app's internals, with terminal capabilities declared.
 * Keeping it (SSH_AUTH_SOCK, proxies, language, tool paths) is what makes git, ssh and
 * version managers behave as they do in any other terminal.
 */
export function terminalEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  options: { shell: string; home?: string; version?: string }
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !INTERNAL.test(key)) env[key] = value
  const path = (env.PATH ?? '').split(':').filter(Boolean)
  env.PATH = [
    ...LEADING_PATHS.filter((entry) => !path.includes(entry)),
    ...path,
    ...TRAILING_PATHS.filter((entry) => !path.includes(entry))
  ].join(':')
  if (options.home) env.HOME = options.home
  env.SHELL = options.shell
  if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'PiDesktop'
  if (options.version) env.TERM_PROGRAM_VERSION = options.version
  return env
}
