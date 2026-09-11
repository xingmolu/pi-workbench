import { describe, expect, it } from 'vitest'
import { BrowserTargets } from './browser-targets'

describe('Main BrowserTargets boundary', () => {
  it('disposal immediately blocks new calls and rejects already pending results', async () => {
    const pending: ((value: unknown) => void)[] = []
    const targets = new BrowserTargets({
      executeJavaScriptInIsolatedWorld: () => new Promise((resolve) => pending.push(resolve))
    })
    const nonce = '00000000-0000-4000-8000-000000000000'
    const locating = targets.locate(nonce + ':1')
    const disposal = targets.dispose()
    const denied = targets.snapshot()
    // Avoid hanging if the old implementation admits another script.
    pending.forEach((resolve, index) =>
      resolve(index === 1 ? true : { nonce, x: 1, y: 1, width: 800, height: 600 })
    )
    await expect(denied).rejects.toThrow()
    await expect(locating).rejects.toThrow('disposed')
    await disposal.catch(() => undefined)
    expect(pending).toHaveLength(2)
  })
  it('rejects selectors, scripts and oversized action input before executing', async () => {
    let calls = 0
    const targets = new BrowserTargets({
      executeJavaScriptInIsolatedWorld: async () => {
        calls++
        return true
      }
    })
    for (const ref of ['#one', 'document.body.click()', null, {}, 'x'.repeat(1000)])
      await expect(targets.locate(ref)).rejects.toThrow()
    await expect(
      targets.fill('00000000-0000-4000-8000-000000000000:1', 'x'.repeat(10001))
    ).rejects.toThrow()
    expect(calls).toBe(0)
  })
  it('rejects malformed and out-of-viewport point results', async () => {
    const nonce = '00000000-0000-4000-8000-000000000000'
    for (const result of [
      null,
      true,
      { nonce, x: NaN, y: 1, width: 800, height: 600 },
      { nonce, x: 800, y: 1, width: 800, height: 600 },
      { nonce: '10000000-0000-4000-8000-000000000000', x: 1, y: 1, width: 800, height: 600 }
    ]) {
      const targets = new BrowserTargets({ executeJavaScriptInIsolatedWorld: async () => result })
      await expect(targets.locate(nonce + ':1')).rejects.toThrow()
    }
  })
  it('rejects malformed snapshots and action results from renderer', async () => {
    const targets = new BrowserTargets({ executeJavaScriptInIsolatedWorld: async () => ({}) })
    await expect(targets.snapshot()).rejects.toThrow()
    await expect(targets.fill('00000000-0000-4000-8000-000000000000:1', 'value')).rejects.toThrow()
  })
})
