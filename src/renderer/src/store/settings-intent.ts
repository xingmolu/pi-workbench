import { create } from 'zustand'

/** Something another surface asked Settings to show when it next opens. */
type SettingsIntent = 'add-api' | 'forges'

export const useSettingsIntent = create<{
  intent: SettingsIntent | null
  request: (intent: SettingsIntent) => void
  take: (intent: SettingsIntent) => boolean
}>((set, get) => ({
  intent: null,
  request: (intent) => set({ intent }),
  take: (intent) => {
    if (get().intent !== intent) return false
    set({ intent: null })
    return true
  }
}))
