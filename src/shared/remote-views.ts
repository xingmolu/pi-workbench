import { z } from 'zod'

/**
 * Remote views let the paired phone watch (and, if allowed, drive) the desktop's workbench
 * views: the built-in browser as a frame stream, terminals as their output. One access level,
 * chosen on the desktop, covers every view.
 */
export const remoteViewAccessSchema = z.enum(['off', 'view', 'control'])
export type RemoteViewAccess = z.infer<typeof remoteViewAccessSchema>

export type RemoteViewSummary = {
  /** `browser`, or `terminal:<terminalId>`. */
  id: string
  kind: 'browser' | 'terminal'
  title: string
  detail?: string
  live: boolean
}

export type RemoteBrowserFrame = {
  /** Base64 JPEG of the page's viewport. */
  data: string
  /** CSS pixels the image covers; taps are sent in these coordinates. */
  width: number
  height: number
}

export type RemoteBrowserTab = {
  id: string
  title: string
  url: string
  active: boolean
  loading: boolean
}

export type RemoteBrowserState = {
  available: boolean
  tabs: RemoteBrowserTab[]
  canGoBack: boolean
  canGoForward: boolean
  /** Phone-sized emulation of the active page is on. */
  mobile: boolean
  controller: 'idle' | 'user' | 'agent'
  message?: string
}

const coordinate = z.number().finite().min(0).max(20000)

export const REMOTE_BROWSER_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
] as const

export const remoteBrowserInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('tap'), x: coordinate, y: coordinate }),
  z.strictObject({
    type: z.literal('scroll'),
    x: coordinate,
    y: coordinate,
    dx: z.number().finite().min(-4000).max(4000),
    dy: z.number().finite().min(-4000).max(4000)
  }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.strictObject({ type: z.literal('key'), key: z.enum(REMOTE_BROWSER_KEYS) }),
  z.strictObject({ type: z.literal('navigate'), url: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.enum(['back', 'forward', 'reload', 'new_tab', 'wake']) }),
  z.strictObject({ type: z.enum(['select_tab', 'close_tab']), pageId: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal('device'), mobile: z.boolean() })
])
export type RemoteBrowserInput = z.infer<typeof remoteBrowserInputSchema>

/** Keys a phone keyboard cannot type, sent as the bytes a terminal expects. */
export const REMOTE_TERMINAL_KEYS = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  'Ctrl-C': '\x03',
  'Ctrl-D': '\x04',
  'Ctrl-Z': '\x1a',
  'Ctrl-L': '\x0c'
} as const
export type RemoteTerminalKey = keyof typeof REMOTE_TERMINAL_KEYS

export const remoteTerminalInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), data: z.string().min(1).max(4096) }),
  z.strictObject({
    type: z.literal('key'),
    key: z.enum(Object.keys(REMOTE_TERMINAL_KEYS) as [RemoteTerminalKey, ...RemoteTerminalKey[]])
  })
])
export type RemoteTerminalInput = z.infer<typeof remoteTerminalInputSchema>
