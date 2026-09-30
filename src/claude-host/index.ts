import { hostRequestSchema } from '../shared/schemas'
import { hostResultMatchesCommand } from '../shared/command-result'
import type { ClaudeStorage } from './storage'

const storage = JSON.parse(process.env.PI_DESKTOP_RUNTIME_STORAGE ?? 'null') as ClaudeStorage | null
if (!storage?.config || !storage.sessions || !storage.cache)
  throw new Error('Claude runtime requires desktop-owned storage')
// Native SDK helper configuration is established before the SDK module is ever loaded.
process.env.CLAUDE_CONFIG_DIR = storage.config
const port = process.parentPort
const pending: unknown[] = []
let dispatch: ((message: unknown) => void) | undefined
port.on('message', (event) => {
  if (dispatch) dispatch(event.data)
  else pending.push(event.data)
})

void import('./host')
  .then(({ ClaudeHost }) => {
    const host = new ClaudeHost({
      storage,
      role: process.env.PI_DESKTOP_RUNTIME_ROLE === 'configuration' ? 'configuration' : 'session',
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
          error: 'Invalid Claude host request'
        })
        return
      }
      const request = parsed.data
      void host
        .handle(request, request.expectedIdentity)
        .then((data) => {
          if (!hostResultMatchesCommand(request, data))
            throw new Error(`Claude host result mismatch: ${request.type}`)
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
      'Claude host startup failed:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  })
