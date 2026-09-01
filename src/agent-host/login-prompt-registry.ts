import type { LoginPrompt } from '../shared/contracts'

type PendingLoginPrompt = {
  prompt: LoginPrompt
  resolve: (value: string) => void
  signal?: AbortSignal
  onAbort: () => void
}

export class LoginPromptRegistry {
  private pending: PendingLoginPrompt | null = null

  constructor(private readonly onChange: (prompt: LoginPrompt | null) => void) {}

  get current(): LoginPrompt | null {
    return this.pending?.prompt ?? null
  }

  request(prompt: LoginPrompt, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.resolve('')
    this.clear()
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.finish(prompt.id, '')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending = { prompt, resolve, signal, onAbort }
      this.onChange(prompt)
    })
  }

  resolve(id: string, value?: string): boolean {
    return this.finish(id, value ?? '')
  }

  clear(): boolean {
    const id = this.pending?.prompt.id
    return id ? this.finish(id, '') : false
  }

  private finish(id: string, value: string): boolean {
    const pending = this.pending
    if (!pending || pending.prompt.id !== id) return false
    this.pending = null
    pending.signal?.removeEventListener('abort', pending.onAbort)
    pending.resolve(value)
    this.onChange(null)
    return true
  }
}
