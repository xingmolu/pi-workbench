import { create } from 'zustand'
import type { NavigationLibraryCommand } from '../../../shared/navigation-library'
import { useNavigationLibrary } from './navigation-library'

type Notice = { message: string; error?: boolean; undo?: NavigationLibraryCommand }
export const useNavigationFeedback = create<{
  notice: Notice | null
  notify: (notice: Notice) => void
  dismiss: () => void
}>((set) => ({
  notice: null,
  notify: (notice) => set({ notice }),
  dismiss: () => set({ notice: null })
}))

export async function performNavigationAction(
  command: NavigationLibraryCommand,
  message?: string,
  undo?: NavigationLibraryCommand
): Promise<boolean> {
  try {
    await useNavigationLibrary.getState().dispatch(command)
    if (message) useNavigationFeedback.getState().notify({ message, undo })
    return true
  } catch (error) {
    useNavigationFeedback
      .getState()
      .notify({ message: error instanceof Error ? error.message : String(error), error: true })
    return false
  }
}
