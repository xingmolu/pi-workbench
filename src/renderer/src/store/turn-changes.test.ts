import { describe, expect, it } from 'vitest'
import type { ConversationNode, ToolFileChange } from '../../../shared/contracts'
import { displayChangePath, summarizeTurnChanges } from './turn-changes'

const change = (path: string, additions: number, deletions: number): ToolFileChange => ({
  path,
  kind: 'edit',
  source: 'applied',
  anchored: true,
  patch: '',
  additions,
  deletions
})
const tool = (
  id: string,
  status: Extract<ConversationNode, { type: 'tool' }>['status'],
  fileChange?: ToolFileChange
): ConversationNode => ({
  id,
  type: 'tool',
  toolCallId: id,
  name: 'edit',
  intent: 'diff',
  title: 'edit',
  status,
  ...(fileChange ? { change: fileChange } : {})
})

describe('turn change receipt', () => {
  it('merges repeated edits per file in first-touched order', () => {
    const files = summarizeTurnChanges([
      tool('a', 'success', change('b.ts', 2, 1)),
      tool('b', 'success', change('a.ts', 1, 0)),
      tool('c', 'success', change('b.ts', 3, 2))
    ])
    expect(
      files.map((file) => [file.path, file.additions, file.deletions, file.changes.length])
    ).toEqual([
      ['b.ts', 5, 3, 2],
      ['a.ts', 1, 0, 1]
    ])
  })

  it('ignores calls that did not change anything', () => {
    expect(
      summarizeTurnChanges([
        tool('a', 'error', change('x.ts', 1, 0)),
        tool('b', 'blocked', change('x.ts', 1, 0)),
        tool('c', 'incomplete', change('x.ts', 1, 0)),
        tool('d', 'success'),
        { id: 'u', type: 'user', text: 'x' }
      ])
    ).toEqual([])
  })

  it('shows project-relative directories and keeps the file name separate', () => {
    expect(displayChangePath('/w/shop/src/cart.ts', '/w/shop')).toEqual({
      dir: 'src/',
      name: 'cart.ts'
    })
    expect(displayChangePath('/w/shop/src/cart.ts', '/w/shop/')).toEqual({
      dir: 'src/',
      name: 'cart.ts'
    })
    expect(displayChangePath('/elsewhere/a.ts', '/w/shop')).toEqual({
      dir: '/elsewhere/',
      name: 'a.ts'
    })
    expect(displayChangePath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })
})
