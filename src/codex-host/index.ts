import { hostRequestSchema } from '../shared/schemas'
import { hostResultMatchesCommand } from '../shared/command-result'
import type { CodexStorage } from './storage'

const storage = JSON.parse(process.env.PI_DESKTOP_RUNTIME_STORAGE ?? 'null') as CodexStorage | null
if (!storage?.config || !storage.sessions || !storage.cache)
  throw new Error('Codex runtime requires desktop-owned storage')
const port = process.parentPort
const pending: unknown[] = []
let dispatch: ((message: unknown) => void) | undefined
port.on('message', (event) => {
  if (dispatch) dispatch(event.data)
  else pending.push(event.data)
})

void import('./host')
  .then(({ CodexHost }) => {
    const host = new CodexHost({
      storage,
      role: process.env.PI_DESKTOP_RUNTIME_ROLE === 'configuration' ? 'configuration' : 'session',
      ...(process.env.PI_DESKTOP_CODEX_EXECUTABLE
        ? { executable: process.env.PI_DESKTOP_CODEX_EXECUTABLE }
        : {}),
      // Tests point Codex at a local model server through extra config overrides.
      ...(process.env.PI_DESKTOP_CODEX_CONFIG
        ? { config: JSON.parse(process.env.PI_DESKTOP_CODEX_CONFIG) as string[] }
        : {}),
      post: (message) => port.postMessage(message)
    })
    dispatch = (message) => {
      if (host.accept(message)) return
      const parsed = hostRequestSchema.safeParse(message)
      if (!parsed.success) {
        const value = message as { requestId?: string } | null
        port.postMessage({
          type: 'response',
          requestId: value?.requestId ?? 'invalid',
          ok: false,
          error: 'Invalid Codex host request'
        })
        return
      }
      const request = parsed.data
      void host
        .handle(request, request.expectedIdentity)
        .then((data) => {
          if (!hostResultMatchesCommand(request, data))
            throw new Error(`Codex host result mismatch: ${request.type}`)
          port.postMessage({ type: 'response', requestId: request.requestId, ok: true, data })
        })
        .catch((error) =>
          port.postMessage({
            type: 'response',
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        )
    }
    for (const message of pending.splice(0)) dispatch(message)
  })
  .catch((error) => {
    console.error(
      'Codex host startup failed:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  })
