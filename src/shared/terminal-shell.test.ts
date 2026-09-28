import { expect, it } from 'vitest'
import { resolveShell, shellArgs, shellName, terminalEnvironment } from './terminal-shell'

it('uses the first executable shell of the user, then zsh, bash and sh', () => {
  const has = (paths: string[]) => (path: string) => paths.includes(path)
  expect(resolveShell(['/usr/local/bin/fish'], has(['/usr/local/bin/fish', '/bin/zsh']))).toBe(
    '/usr/local/bin/fish'
  )
  expect(resolveShell(['/missing/zsh', null], has(['/bin/bash']))).toBe('/bin/bash')
  expect(resolveShell(['relative/zsh', 'bad\0'], has(['relative/zsh', '/bin/sh']))).toBe('/bin/sh')
  expect(resolveShell([], has([]))).toBe('/bin/sh')
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
    { shell: '/bin/zsh', home: '/Users/me', version: '0.1.0' }
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
  expect(terminalEnvironment({}, { shell: '/bin/sh' }).LANG).toBe('en_US.UTF-8')
})
