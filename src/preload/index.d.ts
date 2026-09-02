import type { PiDesktopAPI, PluginPanelAPI } from '../shared/contracts'

declare global {
  interface Window {
    pi: PiDesktopAPI
    piPlugin: PluginPanelAPI
  }
}

export {}
