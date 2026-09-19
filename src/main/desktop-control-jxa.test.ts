import { describe, expect, it, vi } from 'vitest'
import { jxaClick, jxaType, runJxa } from './desktop-control-jxa'

describe('desktop-control JXA helpers', () => {
  it('parses osascript JSON and never shells user text into click coords', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }) }))
    await expect(runJxa(exec, 'function run(){return 1}')).resolves.toEqual({ ok: true })
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', 'function run(){return 1}'],
      { timeout: 8000, maxBuffer: 512 * 1024 }
    )
    expect(jxaClick(10.9, 20.2, 'left')).toContain('var x=10')
    expect(jxaClick(10.9, 20.2, 'left')).toContain('var y=20')
    expect(jxaClick(1, 2, 'left')).not.toContain('rm -rf')
    expect(jxaType('say "hi"')).toContain(JSON.stringify('say "hi"'))
  })

  it('does not start osascript when Computer Use was already cancelled', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }) }))
    const controller = new AbortController()
    controller.abort()

    await expect(
      runJxa(exec, 'function run(){return 1}', controller.signal)
    ).rejects.toThrow(/停止/)
    expect(exec).not.toHaveBeenCalled()
  })
})
