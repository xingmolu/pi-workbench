import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type AgentHostStatus = {
  ready: boolean
  stub: boolean
  engine: string
  agentDir: string
}

const api = {
  getAgentHostStatus: (): Promise<AgentHostStatus> => ipcRenderer.invoke('agent-host:status')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
