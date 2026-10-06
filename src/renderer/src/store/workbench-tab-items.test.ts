import { describe, expect, it } from 'vitest'
import type { BrowserState, WorkbenchContribution } from '../../../shared/contracts'
import { isActiveTab, workbenchTabItems } from './workbench-tab-items'

const contribution = (viewId: string, adapter: string): WorkbenchContribution =>
  ({
    pluginId: 'works.pi',
    viewId,
    title: viewId,
    icon: 'plugin',
    activation: 'onApp',
    surface:
      adapter === 'browser' ? { kind: 'native-view', adapter } : { kind: 'first-party', adapter }
  }) as WorkbenchContribution
const browser = (pages: { id: string; title?: string; url?: string }[]): BrowserState => ({
  available: true,
  visible: true,
  activePageId: pages[1]?.id ?? pages[0]?.id ?? null,
  controller: 'idle',
  pages: pages.map((page) => ({
    id: page.id,
    title: page.title ?? '',
    url: page.url ?? 'about:blank',
    active: false,
    loading: false,
    canGoBack: false,
    canGoForward: false
  }))
})

describe('workbenchTabItems', () => {
  const contributions = [contribution('files', 'files'), contribution('web', 'browser')]

  it('gives every browser page its own tab, in place of the browser', () => {
    const state = browser([
      { id: 'a', title: 'Docs', url: 'https://docs.dev/' },
      { id: 'b', url: 'https://x.dev/' },
      { id: 'c' }
    ])
    const items = workbenchTabItems(contributions, ['files', 'web'], state, 'New tab')
    expect(items.map(({ key, title }) => [key, title])).toEqual([
      ['files', 'files'],
      ['web#a', 'Docs'],
      ['web#b', 'https://x.dev/'],
      ['web#c', 'New tab']
    ])
    expect(items.map((item) => isActiveTab(item, 'web', state))).toEqual([
      false,
      false,
      true,
      false
    ])
  })

  it('shows the browser itself until it has pages', () => {
    const items = workbenchTabItems(contributions, ['web'], browser([]), 'New tab')
    expect(items).toMatchObject([{ key: 'web', title: 'web' }])
  })
})
