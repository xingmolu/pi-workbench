import type { PiDesktopAPI } from '../shared/contracts'

declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}

export {}
