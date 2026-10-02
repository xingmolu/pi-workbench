import { contextBridge, ipcRenderer } from 'electron'
import {
  WORKBENCH_PANEL_CHANNEL,
  WORKBENCH_PANEL_CONTEXT_CHANNEL
} from '../shared/workbench-contracts'
import { createPiDesktopPluginBridge, createPluginPanelClient } from './plugin-client'

const api = createPluginPanelClient({
  invoke: (command) => ipcRenderer.invoke(WORKBENCH_PANEL_CHANNEL, command),
  onContext: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value)
    ipcRenderer.on(WORKBENCH_PANEL_CONTEXT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WORKBENCH_PANEL_CONTEXT_CHANNEL, handler)
  }
})

contextBridge.exposeInMainWorld('piPlugin', api)
// `manifest.json` plugins use this name.
contextBridge.exposeInMainWorld('pluginBridge', createPiDesktopPluginBridge(api))
