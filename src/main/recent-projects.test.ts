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

it('keeps Windows drive paths and drops relative ones', () => {
  expect(mergeRecentProjects(['C:\\work\\a', 'relative', 'D:\\b'], 'C:\\work\\c', 'win32')).toEqual(
    ['C:\\work\\c', 'C:\\work\\a', 'D:\\b']
  )
  expect(mergeRecentProjects(['C:\\work\\a', 'relative', '/a'], undefined, 'linux')).toEqual(['/a'])
})
