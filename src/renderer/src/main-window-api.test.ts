import { describe, expect, it } from 'vitest'

type AssertFalse<Value extends false> = Value
type MainWindowHasPluginApi = 'piPlugin' extends keyof Window ? true : false
type MainWindowDoesNotHavePluginApi = AssertFalse<MainWindowHasPluginApi>

describe('main Renderer Window API declaration', () => {
  it('keeps plugin-only capabilities out of the main Renderer global', () => {
    expect(false satisfies MainWindowDoesNotHavePluginApi).toBe(false)
  })
})
