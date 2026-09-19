import { create } from 'zustand'
import {
  emptyNavigationLibrary,
  navigationLibrarySchema,
  type NavigationLibraryCommand,
  type NavigationLibraryState
} from '../../../shared/navigation-library'

export function createNavigationLibraryStore(
  invoke: (command: NavigationLibraryCommand) => Promise<unknown>
) {
  let hydration: Promise<void> | undefined
  return create<{
    library: NavigationLibraryState
    loaded: boolean
    pending: number
    error: string | null
    accept: (value: NavigationLibraryState) => void
    hydrate: () => Promise<void>
    dispatch: (command: NavigationLibraryCommand) => Promise<void>
  }>((set, get) => ({
    library: emptyNavigationLibrary(),
    loaded: false,
    pending: 0,
    error: null,
    accept: (library) =>
      set((current) =>
        library.revision < current.library.revision
          ? current
          : { library, loaded: true, error: null }
      ),
    hydrate: () =>
      (hydration ??= get()
        .dispatch({ type: 'get' })
        .catch(() => {})
        .finally(() => {
          hydration = undefined
        })),
    dispatch: async (command) => {
      set((state) => ({ pending: state.pending + 1, error: null }))
      try {
        get().accept(navigationLibrarySchema.parse(await invoke(command)))
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
            : String(error)
        set({ error: message })
        throw new Error(message)
      } finally {
        set((state) => ({ pending: state.pending - 1 }))
      }
    }
  }))
}
export const useNavigationLibrary = createNavigationLibraryStore((command) =>
  window.pi.navigationLibrary(command)
)
