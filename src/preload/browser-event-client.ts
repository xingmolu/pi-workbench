import type { BrowserEvent } from '../shared/contracts'
import { browserEventSchema } from '../shared/schemas'

export type BrowserEventTransport = {
  onEvent(listener: (event: unknown) => void): () => void
}

export function createBrowserEventSubscriber(
  transport: BrowserEventTransport
): (listener: (event: BrowserEvent) => void) => () => void {
  return (listener) =>
    transport.onEvent((event) => {
      const parsed = browserEventSchema.safeParse(event)
      if (parsed.success) listener(parsed.data)
    })
}
