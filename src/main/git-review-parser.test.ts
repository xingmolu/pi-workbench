import { describe, expect, it } from 'vitest'
import { parseGitStatus, parseGitNameStatus, parseGitRaw } from './git-review-parser'

const oid = '0'.repeat(40)
const tracked = (path: string, xy = 'M.', sub = 'N...') =>
  `1 ${xy} ${sub} 100644 100644 100644 ${oid} ${oid} ${path}\0`

describe('Git inventory byte protocols', () => {
  it('represents an untracked nested repository directory without accepting malformed path segments', () => {
    expect(parseGitStatus(Buffer.from('? nested/\0'))).toEqual([
      { kind: 'untracked', path: 'nested', directory: true }
    ])
    expect(() => parseGitStatus(Buffer.from('? nested//\0'))).toThrow()
  })
  it('preserves raw diff modes and odd names without accepting rename or truncated metadata', () => {
    expect(
      parseGitRaw(
        Buffer.from(
          `:000000 160000 ${oid} ${oid} A\0module\0:100644 120000 ${oid} ${oid} T\0 odd\nname \0`
        )
      )
    ).toEqual([
      { oldMode: '000000', newMode: '160000', status: 'A', path: 'module' },
      { oldMode: '100644', newMode: '120000', status: 'T', path: ' odd\nname ' }
    ])
    for (const value of [
      `:100644 100644 ${oid} ${oid} R100\0a\0b\0`,
      ':bad\0name\0',
      `:100644 100644 ${oid} ${oid} M\0`
    ])
      expect(() => parseGitRaw(Buffer.from(value))).toThrow()
  })
  it('handles empty, untracked, deletion, conflict and submodule records and skips headers', () => {
    expect(parseGitStatus(Buffer.alloc(0))).toEqual([])
    expect(parseGitNameStatus(Buffer.alloc(0))).toEqual([])
    expect(
      parseGitStatus(
        Buffer.from(
          `# branch.head main\0# future.key anything\0? :new\\file\0${tracked('gone', 'D.')}${tracked('module', '.M', 'SCMU')}u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict\0`
        )
      )
    ).toMatchObject([
      { kind: 'untracked', path: ':new\\file' },
      { kind: 'tracked', path: 'gone', indexStatus: 'D', worktreeStatus: '.' },
      { kind: 'tracked', path: 'module', submodule: 'SCMU' },
      {
        kind: 'conflict',
        path: 'conflict',
        indexStatus: 'U',
        worktreeStatus: 'U',
        baseMode: '100644',
        oursMode: '100644',
        theirsMode: '100644',
        worktreeMode: '100644'
      }
    ])
  })
  it.each([
    '? truncated',
    '? \0',
    'unknown\0',
    '\0',
    '2 R. N... 100644 100644 100644 x x R100 new\0old\0',
    tracked('a', 'Z.'),
    tracked('a', 'M'),
    tracked('a', 'M.', 'garbage'),
    tracked('a').replace('100644', 'badmode'),
    tracked('a').replace(oid, 'not-an-oid'),
    'u MM N... 100644 100644 100644 100644 ' + oid + ' ' + oid + ' ' + oid + ' conflict\0',
    '! ignored\0',
    '# malformed\0',
    '? /absolute\0',
    '? ../escape\0',
    '? a/../b\0',
    '? a//b\0'
  ])('rejects malformed or unsupported status framing: %j', (input) => {
    expect(() => parseGitStatus(Buffer.from(input))).toThrow('Git inventory')
  })
  it('rejects invalid UTF-8 in either protocol without replacement paths', () => {
    expect(() => parseGitStatus(Buffer.from([63, 32, 255, 0]))).toThrow('Git inventory')
    expect(() => parseGitNameStatus(Buffer.from([77, 0, 255, 0]))).toThrow('Git inventory')
  })
  it.each([
    'M\0truncated',
    'M\0',
    'R100\0new\0old\0',
    'C100\0new\0old\0',
    'Z\0a\0',
    'M\0\0',
    'M\0../a\0'
  ])('rejects malformed name-status framing: %j', (input) => {
    expect(() => parseGitNameStatus(Buffer.from(input))).toThrow('Git inventory')
  })
  it('preserves all odd names in branch inventory, including an initial BOM', () => {
    const paths = [' a ', '\t', '\n', '中文', '-x', ':x', 'a\\b', '\ufeffa']
    expect(parseGitNameStatus(Buffer.from(paths.map((p) => `T\0${p}\0`).join('')))).toEqual(
      paths.map((path) => ({ status: 'T', path }))
    )
  })
  it('preserves status BOM filenames and distinct conflict stage modes', () => {
    expect(parseGitStatus(Buffer.from('? \ufeffa\0'))).toEqual([
      { kind: 'untracked', path: '\ufeffa' }
    ])
    expect(
      parseGitStatus(Buffer.from(`u AU N... 000000 100755 000000 100644 ${oid} ${oid} ${oid} a\0`))
    ).toEqual([
      {
        kind: 'conflict',
        path: 'a',
        indexStatus: 'A',
        worktreeStatus: 'U',
        submodule: 'N...',
        baseMode: '000000',
        oursMode: '100755',
        theirsMode: '000000',
        worktreeMode: '100644'
      }
    ])
  })
  it('preserves opaque paths and separates index and worktree status', () => {
    const paths = [
      ' leading and trailing ',
      'tab\tname',
      'new\nline',
      '中文',
      '-option',
      ':magic',
      'back\\slash'
    ]
    expect(parseGitStatus(Buffer.from(paths.map((p) => tracked(p, 'MD')).join('')))).toEqual(
      paths.map((path) => ({
        kind: 'tracked',
        path,
        indexStatus: 'M',
        worktreeStatus: 'D',
        submodule: 'N...',
        headMode: '100644',
        indexMode: '100644',
        worktreeMode: '100644'
      }))
    )
    expect(parseGitNameStatus(Buffer.from('M\0a b\0D\0deleted\0'))).toEqual([
      { status: 'M', path: 'a b' },
      { status: 'D', path: 'deleted' }
    ])
  })
})
