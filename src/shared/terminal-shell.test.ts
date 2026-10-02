import { expect, it } from 'vitest'
import {
  resolveShell,
  shellArgs,
  shellName,
  terminalEnvironment,
  windowsTerminalFixtureEnv
} from './terminal-shell'

it('uses the first executable shell of the user, then zsh, bash and sh', () => {
  const has = (paths: string[]) => (path: string) => paths.includes(path)
  expect(
    resolveShell(['/usr/local/bin/fish'], has(['/usr/local/bin/fish', '/bin/zsh']), 'darwin')
  ).toBe('/usr/local/bin/fish')
  expect(resolveShell(['/missing/zsh', null], has(['/bin/bash']), 'linux')).toBe('/bin/bash')
  expect(resolveShell(['relative/zsh', 'bad\0'], has(['relative/zsh', '/bin/sh']), 'linux')).toBe(
    '/bin/sh'
  )
  expect(resolveShell([], has([]), 'linux')).toBe('/bin/sh')
})

it('starts a login shell, or skips startup files in the syntax of the isolated shell', () => {
  expect(shellArgs('/bin/zsh', false)).toEqual(['-l'])
  expect(shellArgs('/bin/zsh', true)).toEqual(['-f'])
  expect(shellArgs('/usr/bin/bash', true)).toEqual(['--noprofile', '--norc'])
  expect(shellArgs('/bin/sh', true)).toEqual([])
  expect(shellName('-zsh')).toBe('zsh')
})

it('keeps the user environment, drops app internals and declares terminal capabilities', () => {
  const env = terminalEnvironment(
    {
      PATH: '/Users/me/.cargo/bin:/usr/bin:/bin',
      SSH_AUTH_SOCK: '/private/tmp/agent.sock',
      HTTPS_PROXY: 'http://proxy:8080',
      LC_ALL: 'zh_CN.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
      PI_DESKTOP_E2E: '1',
      npm_config_cache: '/tmp',
      UNSET: undefined
    },
    { shell: '/bin/zsh', home: '/Users/me', version: '0.1.0' },
    'darwin'
  )
  expect(env).toEqual({
    PATH: '/opt/homebrew/bin:/usr/local/bin:/Users/me/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    SSH_AUTH_SOCK: '/private/tmp/agent.sock',
    HTTPS_PROXY: 'http://proxy:8080',
    LC_ALL: 'zh_CN.UTF-8',
    HOME: '/Users/me',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'PiDesktop',
    TERM_PROGRAM_VERSION: '0.1.0'
  })
  expect(terminalEnvironment({}, { shell: '/bin/sh' }, 'linux').LANG).toBe('en_US.UTF-8')
})

it('on Windows prefers PowerShell 7, then Windows PowerShell, then cmd', () => {
  const env = {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe'
  }
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const has = (paths: string[]) => (path: string) => paths.includes(path)
  expect(resolveShell([], has([pwsh, powershell]), 'win32', env)).toBe(pwsh)
  expect(resolveShell([undefined], has([powershell]), 'win32', env)).toBe(powershell)
  expect(resolveShell([], has([]), 'win32', env)).toBe('C:\\Windows\\System32\\cmd.exe')
  expect(resolveShell(['D:\\tools\\nu.exe'], has(['D:\\tools\\nu.exe']), 'win32', env)).toBe(
    'D:\\tools\\nu.exe'
  )
  expect(shellName(pwsh)).toBe('pwsh')
  expect(shellArgs(pwsh, false)).toEqual(['-NoLogo'])
  expect(shellArgs(powershell, true)).toEqual(['-NoLogo', '-NoProfile'])
  expect(shellArgs('C:\\Windows\\System32\\cmd.exe', true)).toEqual(['/d'])
})

it('leaves the Windows PATH and home as they are', () => {
  const env = terminalEnvironment(
    { Path: 'C:\\Windows\\System32;C:\\tools', USERPROFILE: 'C:\\Users\\me' },
    { shell: 'C:\\pwsh.exe', home: 'C:\\Users\\me' },
    'win32'
  )
  expect(env.Path).toBe('C:\\Windows\\System32;C:\\tools')
  expect(env).not.toHaveProperty('PATH')
  expect(env).not.toHaveProperty('HOME')
  expect(env.SHELL).toBe('C:\\pwsh.exe')
})

it('gives the isolated Windows terminal only system directories and a fixed home', () => {
  const env = windowsTerminalFixtureEnv(
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\t\\home',
    'C:\\t\\tmp',
    {
      SystemRoot: 'C:\\Windows'
    }
  )
  expect(env.Path).toBe(
    'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
  )
  expect(env).toMatchObject({
    USERPROFILE: 'C:\\t\\home',
    TEMP: 'C:\\t\\tmp',
    SystemRoot: 'C:\\Windows'
  })
})
