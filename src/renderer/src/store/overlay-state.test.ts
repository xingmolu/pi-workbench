import { expect, it } from 'vitest'
import { createOverlayState, PaletteRequestEpoch } from './overlay-state'

it('keeps app dialogs exclusive and native suspension owned until the actual dialog closes', () => {
  const overlays = createOverlayState()
  expect(overlays.getState().open('settings')).toBe(true)
  expect(overlays.getState().open('command')).toBe(false)
  overlays.getState().close('command')
  expect(overlays.getState().active).toBe('settings')
  overlays.getState().close('settings')
  expect(overlays.getState().open('command')).toBe(true)
  overlays.getState().close('command')
  expect(overlays.getState().active).toBe(null)
})

it('a late file-search acknowledgement cannot consume the next request after the first was consumed', () => {
  const overlays = createOverlayState()
  overlays.getState().requestFileSearch('/a')
  const first = overlays.getState().fileSearch!.revision
  overlays.getState().consumeFileSearch(first)
  overlays.getState().requestFileSearch('/b')
  overlays.getState().consumeFileSearch(first)
  expect(overlays.getState().fileSearch?.cwd).toBe('/b')
})

it('invalidates late results and actions after a new query, close, or source identity change', () => {
  const epoch = new PaletteRequestEpoch()
  const first = epoch.begin('session-1:3')
  expect(epoch.current(first, 'session-1:3')).toBe(true)
  epoch.begin('session-1:3')
  expect(epoch.current(first, 'session-1:3')).toBe(false)
  const second = epoch.begin('session-1:3')
  expect(epoch.current(second, 'session-2:4')).toBe(false)
  epoch.invalidate()
  expect(epoch.current(second, 'session-1:3')).toBe(false)
})
