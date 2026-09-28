import { create } from 'zustand'

/**
 * One-shot request to place text in the current draft. Never sends; the user still decides.
 * `replace` sets the draft (starter prompts); `append` adds below what is already typed
 * (quoting terminal output into the conversation).
 */
export const useComposerPrefill = create<{
  pending: string | null
  mode: 'replace' | 'append'
  request: (text: string, mode?: 'replace' | 'append') => void
  consume: () => string | null
}>((set, get) => ({
  pending: null,
  mode: 'replace',
  request: (text, mode = 'replace') => set({ pending: text, mode }),
  consume: () => {
    const text = get().pending
    set({ pending: null })
    return text
  }
}))
