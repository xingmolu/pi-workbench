import { contextBridge, ipcRenderer } from 'electron'
import type { AgentSnapshot, HostCommand, HostEvent, PiDesktopAPI } from '../shared/contracts'

const api: PiDesktopAPI = {
  getState: (): Promise<AgentSnapshot> => ipcRenderer.invoke('pi:state'),
  selectProject: (): Promise<AgentSnapshot | null> => ipcRenderer.invoke('pi:select-project'),
  send: (command: HostCommand): Promise<AgentSnapshot> => ipcRenderer.invoke('pi:command', command),
  onEvent: (listener: (event: HostEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: HostEvent): void => listener(value)
    ipcRenderer.on('pi:event', handler)
    return () => ipcRenderer.removeListener('pi:event', handler)
  }
}

contextBridge.exposeInMainWorld('pi', api)
