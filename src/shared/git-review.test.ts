import { describe, expect, it } from 'vitest'
import { gitReviewCommandSchema } from './git-review'

describe('Git Review narrow command contract', () => {
  it('accepts explicit views and opaque patch authorization only', () => {
    expect(
      gitReviewCommandSchema.safeParse({
        type: 'list',
        projectPath: '/project',
        view: 'branch',
        baseRef: 'refs/heads/topic'
      }).success
    ).toBe(true)
    for (const command of [
      { type: 'list', projectPath: '/project', view: 'HEAD' },
      { type: 'patch', projectPath: '/project', reviewId: 'r', entryId: 'e', path: '../secret' },
      { type: 'refs', projectPath: '/project', args: ['fetch'] },
      { type: 'list', projectPath: '/project', view: 'branch', baseRef: '--help' },
      { type: 'list', projectPath: '/project', view: 'branch', baseRef: 'HEAD~1' },
      { type: 'list', projectPath: '/project', view: 'unstaged', baseRef: 'refs/heads/main' }
    ])
      expect(gitReviewCommandSchema.safeParse(command).success).toBe(false)
  })
})
