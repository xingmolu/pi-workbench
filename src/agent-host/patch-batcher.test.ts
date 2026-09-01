import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PatchBatcher } from './patch-batcher'

describe('PatchBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces updates, flushes immediately, and cancels on dispose', async () => {
    const publish = vi.fn()
    const batcher = new PatchBatcher(publish, 32)

    batcher.schedule()
    batcher.schedule()
    await vi.advanceTimersByTimeAsync(31)
    expect(publish).not.toHaveBeenCalled()

    batcher.flush()
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(publish).toHaveBeenCalledTimes(1)

    batcher.schedule()
    batcher.dispose()
    await vi.advanceTimersByTimeAsync(32)
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
