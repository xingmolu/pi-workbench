import { create } from 'zustand'
import type { AgentRuntimeManifest } from '../../../shared/agent-runtime'

export const useRuntimeCatalog = create<{
  runtimes: AgentRuntimeManifest[]
  load: () => Promise<void>
}>((set) => ({
  runtimes: [],
  load: async () => set({ runtimes: await window.pi.listRuntimes() })
}))
