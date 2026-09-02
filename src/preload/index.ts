import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentSnapshot,
  BrowserCommand,
  BrowserCommandResult,
  BrowserEvent,
  HostCommand,
  HostEvent,
  HostResultFor,
  PiDesktopAPI
} from '../shared/contracts'
import { WORKBENCH_CHANNEL, WORKBENCH_EVENT_CHANNEL } from '../shared/workbench-contracts'
import { createBrowserEventSubscriber } from './browser-event-client'
import { createWorkbenchClient } from './workbench-client'

const workbenchClient = createWorkbenchClient({
  invoke: (command) => ipcRenderer.invoke(WORKBENCH_CHANNEL, command),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value)
    ipcRenderer.on(WORKBENCH_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WORKBENCH_EVENT_CHANNEL, handler)
  }
})

const subscribeToBrowserEvent = createBrowserEventSubscriber({
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value)
    ipcRenderer.on('pi:browser:event', handler)
    return () => ipcRenderer.removeListener('pi:browser:event', handler)
  }
})

const api: PiDesktopAPI = {
  getState: (): Promise<AgentSnapshot> => ipcRenderer.invoke('pi:state'),
  selectProject: (): Promise<AgentSnapshot | null> => ipcRenderer.invoke('pi:select-project'),
  send: <Command extends HostCommand>(command: Command): Promise<HostResultFor<Command>> =>
    ipcRenderer.invoke('pi:command', command),
  onEvent: (listener: (event: HostEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: HostEvent): void => listener(value)
    ipcRenderer.on('pi:event', handler)
    return () => ipcRenderer.removeListener('pi:event', handler)
  },
  browser: (command: BrowserCommand): Promise<BrowserCommandResult> =>
    ipcRenderer.invoke('pi:browser', command),
  onBrowserEvent: (listener: (event: BrowserEvent) => void): (() => void) =>
    subscribeToBrowserEvent(listener),
  ...workbenchClient
}

contextBridge.exposeInMainWorld('pi', api)
