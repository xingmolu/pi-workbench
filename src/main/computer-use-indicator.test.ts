import { describe, expect, it, vi } from 'vitest'
import { COMPUTER_USE_STOP_ACCELERATOR, ComputerUseIndicator } from './computer-use-indicator'

type Fixture = {
  deps: {
    registerShortcut: ReturnType<typeof vi.fn>
    unregisterShortcut: ReturnType<typeof vi.fn>
    setBadge: ReturnType<typeof vi.fn>
    notify: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }
  indicator: ComputerUseIndicator
  press: () => void
}

function fixture(registers = true): Fixture {
  let shortcut: (() => void) | undefined
  const deps = {
    registerShortcut: vi.fn((_accelerator: string, callback: () => void) => {
      shortcut = callback
      return registers
    }),
    unregisterShortcut: vi.fn(),
    setBadge: vi.fn(),
    notify: vi.fn(),
    stop: vi.fn()
  }
  return { deps, indicator: new ComputerUseIndicator(deps), press: () => shortcut?.() }
}

describe('ComputerUseIndicator', () => {
  it('announces control once per run and withdraws everything when it ends', () => {
    const { deps, indicator } = fixture()
    indicator.begin('worker-a')
    indicator.begin('worker-a')
    expect(deps.registerShortcut).toHaveBeenCalledTimes(1)
    expect(deps.registerShortcut).toHaveBeenCalledWith(
      COMPUTER_USE_STOP_ACCELERATOR,
      expect.any(Function)
    )
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.setBadge).toHaveBeenLastCalledWith('●')
    indicator.end('worker-b')
    expect(indicator.active).toBe('worker-a')
    indicator.end('worker-a')
    expect(indicator.active).toBeNull()
    expect(deps.unregisterShortcut).toHaveBeenCalledWith(COMPUTER_USE_STOP_ACCELERATOR)
    expect(deps.setBadge).toHaveBeenLastCalledWith('')
  })

  it('stops the controlling run from the global shortcut', () => {
    const { deps, indicator, press } = fixture()
    indicator.begin('worker-a')
    press()
    expect(deps.stop).toHaveBeenCalledWith('worker-a')
    expect(indicator.active).toBeNull()
    press()
    expect(deps.stop).toHaveBeenCalledTimes(1)
  })

  it('hands over to a new owner and leaves an unavailable shortcut alone', () => {
    const { deps, indicator } = fixture(false)
    indicator.begin('worker-a')
    indicator.begin('worker-b')
    expect(indicator.active).toBe('worker-b')
    expect(deps.unregisterShortcut).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('停止')
    )
  })
})
