import { ElectronAPI } from '@electron-toolkit/preload'

export type AgentHostStatus = {
  ready: boolean
  stub: boolean
  engine: string
  agentDir: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getAgentHostStatus: () => Promise<AgentHostStatus>
    }
  }
}

export {}
