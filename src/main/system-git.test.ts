import { expect, it } from 'vitest'
import { systemGit } from './system-git'

it('uses /usr/bin/git outside Windows', () => {
  expect(systemGit('darwin', { PATH: '/evil' })).toEqual({
    path: '/usr/bin/git',
    env: { PATH: '/usr/bin:/bin' }
  })
})

it('finds Git for Windows in its install locations, never on PATH', () => {
  const env = {
    PATH: 'C:\\project\\bin',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
  }
  const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'
  expect(systemGit('win32', env, (path) => path === perUser)).toEqual({
    path: perUser,
    env: {
      PATH: 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd;C:\\Windows\\System32;C:\\Windows',
      SystemRoot: 'C:\\Windows'
    }
  })
  expect(systemGit('win32', env, () => true).path).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  // A relative install root from the environment is ignored.
  expect(
    systemGit('win32', { ProgramFiles: 'relative' }, (path) => path.startsWith('relative')).path
  ).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
})
