import { create } from 'zustand'

/** One-shot request to place text in the current draft. Never sends; the user still decides. */
export const useComposerPrefill = create<{
  pending: string | null
  request: (text: string) => void
  consume: () => string | null
}>((set, get) => ({
  pending: null,
  request: (text) => set({ pending: text }),
  consume: () => {
    const text = get().pending
    set({ pending: null })
    return text
  }
}))
