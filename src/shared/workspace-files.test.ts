import { describe, expect, it } from 'vitest'
import { workspaceFilesCommandSchema } from './workspace-files'

describe('workspace files command boundary', () => {
  it('defaults list path and trims search queries', () => {
    expect(workspaceFilesCommandSchema.parse({ type: 'list', projectPath: '/project' })).toEqual({
      type: 'list',
      projectPath: '/project',
      path: ''
    })
    expect(
      workspaceFilesCommandSchema.parse({ type: 'search', projectPath: '/project', query: ' hi ' })
    ).toMatchObject({ query: 'hi' })
  })
  it.each(['/etc/passwd', '../a', 'a/../b', 'a\\b', 'a\0b', 'C:/a', 'a//b', './a'])(
    'rejects unsafe path %s',
    (path) => {
      expect(
        workspaceFilesCommandSchema.safeParse({ type: 'read', projectPath: '/project', path })
          .success
      ).toBe(false)
    }
  )
  it('rejects empty read, unknown fields and invalid searches', () => {
    for (const command of [
      { type: 'read', path: '' },
      { type: 'list', unexpected: true },
      { type: 'search', query: ' ' },
      { type: 'search', query: 'x'.repeat(101) }
    ]) {
      expect(
        workspaceFilesCommandSchema.safeParse({ projectPath: '/project', ...command }).success
      ).toBe(false)
    }
  })
})
