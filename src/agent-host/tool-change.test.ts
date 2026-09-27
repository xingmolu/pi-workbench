import { describe, expect, it } from 'vitest'
import { parsePatch } from 'diff'
import { appliedToolChange, MAX_TOOL_CHANGE_PATCH, proposedToolChange } from './tool-change'

describe('tool file changes', () => {
  it('projects edit replacements as an unanchored proposed patch', () => {
    const change = proposedToolChange('edit', {
      path: 'src/a.ts',
      edits: [
        { oldText: 'const a = 1\n', newText: 'const a = 2\n' },
        { oldText: 'x\ny\n', newText: 'x\n' }
      ]
    })
    expect(change).toMatchObject({
      path: 'src/a.ts',
      kind: 'edit',
      source: 'proposed',
      anchored: false,
      additions: 1,
      deletions: 2
    })
    const [file] = parsePatch(change!.patch)
    expect(file.hunks).toHaveLength(2)
    expect(file.hunks[1].oldStart).toBeGreaterThan(file.hunks[0].oldStart)
  })

  it('accepts the legacy single replacement and stringified edit arrays', () => {
    expect(proposedToolChange('edit', { path: 'a', oldText: 'a', newText: 'b' })).toMatchObject({
      additions: 1,
      deletions: 1
    })
    expect(
      proposedToolChange('edit', {
        path: 'a',
        edits: JSON.stringify([{ oldText: 'a', newText: 'b' }])
      })
    ).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('projects writes as whole-file additions', () => {
    expect(proposedToolChange('write', { path: 'n.md', content: 'a\nb\nc\n' })).toMatchObject({
      kind: 'write',
      additions: 3,
      deletions: 0
    })
  })

  it('ignores other tools and malformed arguments', () => {
    expect(proposedToolChange('bash', { command: 'ls' })).toBeUndefined()
    expect(proposedToolChange('edit', { path: 'a' })).toBeUndefined()
    expect(proposedToolChange('write', { content: 'x' })).toBeUndefined()
    expect(
      proposedToolChange('edit', { path: 'a', oldText: 'same', newText: 'same' })
    ).toBeUndefined()
  })

  it('omits oversized patches but keeps line counts', () => {
    const content = 'x'.repeat(80) + '\n'
    const change = proposedToolChange('write', {
      path: 'big.txt',
      content: content.repeat(Math.ceil(MAX_TOOL_CHANGE_PATCH / 80) + 10)
    })
    expect(change?.omitted).toBe(true)
    expect(change?.patch).toBe('')
    expect(change?.additions).toBeGreaterThan(2000)
  })

  it('uses the applied patch from Pi edit results', () => {
    const patch = '--- src/a.ts\n+++ src/a.ts\n@@ -10,1 +10,1 @@\n-a\n+b\n'
    expect(appliedToolChange('edit', { patch, diff: '' })).toEqual({
      path: 'src/a.ts',
      kind: 'edit',
      source: 'applied',
      anchored: true,
      patch,
      additions: 1,
      deletions: 1
    })
    expect(appliedToolChange('edit', { patch }, 'given.ts')?.path).toBe('given.ts')
    expect(appliedToolChange('write', { patch })).toBeUndefined()
    expect(appliedToolChange('edit', undefined)).toBeUndefined()
  })
})
