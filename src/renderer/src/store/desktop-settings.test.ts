import { expect, it, vi } from 'vitest'
import { createDesktopSettingsStore } from './desktop-settings'
import { DEFAULT_DESKTOP_SETTINGS as defaults } from '../../../shared/desktop-settings'

it('waits for authoritative save, serializes operations, and prevents a late read from replacing it', async () => {
  let resolve!: (value: unknown) => void
  const invoke = vi.fn(
    () =>
      new Promise<unknown>((done) => {
        resolve = done
      })
  )
  const store = createDesktopSettingsStore(invoke)
  const hydration = store.getState().hydrate()
  await store.getState().save({ codeWrap: true })
  expect(invoke).toHaveBeenCalledTimes(1)
  resolve(defaults)
  await hydration
  const saving = store.getState().save({ codeWrap: true })
  await store.getState().hydrate()
  await store.getState().reset()
  await store.getState().save({ codeFontSize: 16 })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(store.getState().settings.codeWrap).toBe(false)
  resolve({ ...defaults, codeWrap: true })
  await saving
  expect(store.getState().settings.codeWrap).toBe(true)
})
it('retains last confirmed settings on save failure and retry only reads', async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(defaults)
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(defaults)
  const store = createDesktopSettingsStore(invoke)
  await store.getState().hydrate()
  await store.getState().save({ codeWrap: true })
  expect(store.getState()).toMatchObject({
    settings: defaults,
    status: 'error',
    error: 'disk full'
  })
  await store.getState().hydrate()
  expect(invoke.mock.calls[2]).toEqual([{ type: 'get' }])
})
it('rejects malformed responses without accepting false saved state', async () => {
  const store = createDesktopSettingsStore(async () => ({ ...defaults, codeWrap: 'true' }))
  await store.getState().hydrate()
  expect(store.getState().status).toBe('error')
  expect(store.getState().settings).toEqual(defaults)
})
