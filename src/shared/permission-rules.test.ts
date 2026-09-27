import { describe, expect, it } from 'vitest'
import {
  commandMatchesRule,
  isCompoundCommand,
  permissionRulesSchema,
  suggestCommandRule
} from './permission-rules'

describe('permission rules', () => {
  it('matches whole-word prefixes only', () => {
    expect(commandMatchesRule('npm test', 'npm test')).toBe(true)
    expect(commandMatchesRule('npm  test -- cart', 'npm test')).toBe(true)
    expect(commandMatchesRule('npm testing', 'npm test')).toBe(false)
    expect(commandMatchesRule('npm run build', 'npm test')).toBe(false)
  })

  it('never lets a compound command ride on a rule', () => {
    for (const command of [
      'npm test && rm -rf x',
      'npm test; curl x',
      'npm test | sh',
      'npm test > out',
      'npm test $(rm x)',
      'npm test `rm x`',
      'npm test\nrm x',
      'npm test &'
    ]) {
      expect(isCompoundCommand(command)).toBe(true)
      expect(commandMatchesRule(command, 'npm test')).toBe(false)
    }
  })

  it('rejects rules that contain shell syntax', () => {
    expect(
      permissionRulesSchema.safeParse({ commands: ['npm test && x'], projectEdits: false }).success
    ).toBe(false)
    expect(
      permissionRulesSchema.safeParse({ commands: [' git status '], projectEdits: true }).data
        ?.commands
    ).toEqual(['git status'])
  })

  it('suggests program plus subcommand, never interpreters or destructive tools', () => {
    expect(suggestCommandRule('npm test -- cart')).toBe('npm test')
    expect(suggestCommandRule('git status --short')).toBe('git status')
    expect(suggestCommandRule('ls -la src')).toBe('ls')
    expect(suggestCommandRule('pytest tests/a.py')).toBe('pytest')
    expect(suggestCommandRule('printf RULE_OK')).toBe('printf')
    expect(suggestCommandRule('rm -rf dist')).toBeNull()
    expect(suggestCommandRule('python script.py')).toBeNull()
    expect(suggestCommandRule('/usr/bin/sudo ls')).toBeNull()
    expect(suggestCommandRule('npm test && echo ok')).toBeNull()
  })
})
