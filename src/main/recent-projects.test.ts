import { expect, it } from 'vitest'
import { mergeRecentProjects } from './recent-projects'

it('migrates last project and deduplicates confirmed canonical paths with a visible cap', () => {
  expect(mergeRecentProjects(['/a', '/b', '/a'], '/c')).toEqual(['/c', '/a', '/b'])
  expect(mergeRecentProjects(undefined, '/legacy')).toEqual(['/legacy'])
  expect(
    mergeRecentProjects(
      Array.from({ length: 110 }, (_, i) => `/p${i}`),
      '/new'
    )
  ).length(100)
})
