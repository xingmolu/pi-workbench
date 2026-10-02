/** Shell choice and environment for user terminals. Pure, so Main and the host share it. */

const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const

/** An absolute path on either platform: `/usr/bin/zsh`, `C:\…` or a `\\server\share` path. */
export const isAbsoluteShellPath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

const usable = (path: string | null | undefined): path is string =>
  typeof path === 'string' && isAbsoluteShellPath(path) && !path.includes('\0')

/** PowerShell 7, then the Windows PowerShell every install has, then cmd. */
function windowsShells(env: Readonly<Record<string, string | undefined>>): string[] {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? 'C:\\Program Files'
  return [
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    env.ComSpec ?? env.COMSPEC ?? `${systemRoot}\\System32\\cmd.exe`
  ]
}

/** The first absolute, executable shell of the user's choices, then the platform's defaults. */
export function resolveShell(
  preferred: readonly (string | null | undefined)[],
  isExecutable: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const fallbacks = platform === 'win32' ? windowsShells(env) : FALLBACK_SHELLS
  for (const candidate of [...preferred, ...fallbacks])
    if (usable(candidate) && isExecutable(candidate)) return candidate
  return fallbacks.at(-1)!
}

/** `zsh` for `/bin/zsh` or `-zsh`, `pwsh` for `C:\…\pwsh.exe`. */
export function shellName(shell: string): string {
  return (shell.split(/[\\/]/).pop() ?? shell).replace(/^-/, '').replace(/\.exe$/i, '')
}

/**
 * A login shell for real use. The isolated E2E fixture skips every startup file instead, in
 * whichever syntax the shell understands.
 */
export function shellArgs(shell: string, isolated: boolean): string[] {
  const name = shellName(shell).toLowerCase()
  if (name === 'pwsh' || name === 'powershell')
    return isolated ? ['-NoLogo', '-NoProfile'] : ['-NoLogo']
  // cmd's /d skips the AutoRun commands in the registry.
  if (name === 'cmd') return isolated ? ['/d'] : []
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
  options: { shell: string; home?: string; version?: string },
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !INTERNAL.test(key)) env[key] = value
  // Windows keeps its own PATH (spelled `Path`, `;`-separated) and home (USERPROFILE).
  if (platform !== 'win32') {
    const path = (env.PATH ?? '').split(':').filter(Boolean)
    env.PATH = [
      ...LEADING_PATHS.filter((entry) => !path.includes(entry)),
      ...path,
      ...TRAILING_PATHS.filter((entry) => !path.includes(entry))
    ].join(':')
    if (options.home) env.HOME = options.home
  }
  env.SHELL = options.shell
  if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'PiDesktop'
  if (options.version) env.TERM_PROGRAM_VERSION = options.version
  return env
}

/**
 * The isolated E2E terminal on Windows: a fixed home and the system directories only, plus
 * the variables Windows programs need to start at all.
 */
export function windowsTerminalFixtureEnv(
  shell: string,
  home: string,
  temp: string,
  base: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const systemRoot = base.SystemRoot ?? base.SYSTEMROOT ?? 'C:\\Windows'
  return {
    SystemRoot: systemRoot,
    ComSpec: base.ComSpec ?? base.COMSPEC ?? `${systemRoot}\\System32\\cmd.exe`,
    PATHEXT: base.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    Path: [
      shell.slice(0, Math.max(shell.lastIndexOf('\\'), 0)),
      `${systemRoot}\\System32`,
      systemRoot,
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`
    ]
      .filter(Boolean)
      .join(';'),
    USERPROFILE: home,
    HOME: home,
    USERNAME: 'terminal-fixture',
    TEMP: temp,
    TMP: temp,
    SHELL: shell,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'PiDesktop'
  }
}
