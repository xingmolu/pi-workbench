import { create } from 'zustand'
import {
  DEFAULT_DESKTOP_SETTINGS,
  desktopSettingsSchema,
  type DesktopSettings,
  type DesktopSettingsCommand
} from '../../../shared/desktop-settings'

export function createDesktopSettingsStore(
  invoke: (command: DesktopSettingsCommand) => Promise<unknown>
) {
  let epoch = 0
  return create<{
    settings: DesktopSettings
    hasLoaded: boolean
    status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
    error: string | null
    hydrate: () => Promise<void>
    save: (patch: Partial<DesktopSettings>) => Promise<void>
    reset: () => Promise<void>
  }>((set, get) => {
    async function run(command: DesktopSettingsCommand): Promise<void> {
      if (get().status === 'saving' || get().status === 'loading') return
      const current = ++epoch
      set({ status: command.type === 'get' ? 'loading' : 'saving', error: null })
      try {
        const settings = desktopSettingsSchema.parse(await invoke(command))
        if (epoch === current) set({ settings, hasLoaded: true, status: 'ready' })
      } catch (error) {
        if (epoch === current)
          set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      settings: { ...DEFAULT_DESKTOP_SETTINGS },
      hasLoaded: false,
      status: 'idle',
      error: null,
      hydrate: () => run({ type: 'get' }),
      save: (patch) =>
        get().status === 'ready'
          ? run({
              type: 'save',
              settings: desktopSettingsSchema.parse({ ...get().settings, ...patch })
            })
          : Promise.resolve(),
      reset: () => (get().status === 'ready' ? run({ type: 'reset' }) : Promise.resolve())
    }
  })
}
export const useDesktopSettings = createDesktopSettingsStore((command) =>
  window.pi.desktopSettings(command)
)
