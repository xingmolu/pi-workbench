import { z } from 'zod'
import { isAbsoluteShellPath } from './terminal-shell'

export const TERMINAL_CHANNEL = 'pi:terminal'
export const TERMINAL_EVENT_CHANNEL = 'pi:terminal:event'
export const TERMINAL_LIMITS = {
  perProject: 4,
  total: 8,
  history: 32,
  chunk: 32 * 1024,
  high: 256 * 1024,
  low: 64 * 1024,
  hard: 1024 * 1024,
  input: 16 * 1024,
  inputPerSecond: 64 * 1024,
  /** Input the PTY has accepted but the shell has not read yet. */
  inputQueue: 8 * 1024 * 1024,
  commandsPerSecond: 128
} as const

const projectPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => isAbsoluteShellPath(v) && !v.includes('\0'))
const identity = {
  projectPath,
  terminalId: z.uuid(),
  generation: z.uuid(),
  connectionEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
}
export const terminalSize = {
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(300)
}
const textBytes = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => new TextEncoder().encode(v).length <= max)
export const terminalCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list'), projectPath }).strict(),
  z.object({ type: z.literal('create'), projectPath, ...terminalSize }).strict(),
  z.object({ type: z.literal('attach'), ...identity }).strict(),
  z
    .object({
      type: z.literal('input'),
      ...identity,
      encoding: z.enum(['utf8', 'binary']).optional(),
      data: z.string().min(1).max(TERMINAL_LIMITS.input)
    })
    .strict()
    .refine((v) =>
      v.encoding === 'binary'
        ? [...v.data].every((c) => c.charCodeAt(0) <= 255)
        : new TextEncoder().encode(v.data).length <= TERMINAL_LIMITS.input
    ),
  z.object({ type: z.literal('resize'), ...identity, ...terminalSize }).strict(),
  z
    .object({
      type: z.literal('ack'),
      ...identity,
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z.object({ type: z.literal('close'), ...identity }).strict()
])
export type TerminalCommand = z.infer<typeof terminalCommandSchema>
export type TerminalIdentity = Pick<
  Extract<TerminalCommand, { type: 'attach' }>,
  keyof typeof identity
>

export const terminalMetadataSchema = z
  .object({
    ...identity,
    ...terminalSize,
    state: z.enum(['starting', 'running', 'exited', 'failed', 'degraded', 'closing']),
    connection: z.enum(['unattached', 'consumer', 'management']),
    exitConfirmed: z.boolean(),
    /** A program other than the shell holds the terminal; absent when the host cannot tell. */
    busy: z.boolean().optional(),
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
    failure: z
      .enum([
        'spawn',
        'output-limit',
        'input-limit',
        'host-exit',
        'host-io',
        'close-timeout',
        'protocol'
      ])
      .nullable()
  })
  .strict()
export type TerminalMetadata = z.infer<typeof terminalMetadataSchema>
export const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), terminal: terminalMetadataSchema }).strict(),
  z
    .object({
      type: z.literal('output'),
      ...identity,
      sequence: z.number().int().positive(),
      data: textBytes(TERMINAL_LIMITS.chunk)
    })
    .strict()
])
export type TerminalEvent = z.infer<typeof terminalEventSchema>
export type TerminalResult =
  | { type: 'list'; terminals: TerminalMetadata[] }
  | { type: 'terminal'; terminal: TerminalMetadata }
  // Accepted for forwarding, not a claim that the shell has consumed stdin.
  | { type: 'ok' }
  | { type: 'unavailable'; message: string }

// Private Main ↔ utility protocol. Never exposed through window.pi.
export const terminalHostCommandSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('spawn'), ...identity, ...terminalSize, degraded: z.boolean() })
    .strict(),
  z.object({ type: z.literal('command'), command: terminalCommandSchema }).strict(),
  z.object({ type: z.literal('detach'), ...identity }).strict(),
  z.object({ type: z.literal('dismiss'), ...identity }).strict(),
  z.object({ type: z.literal('shutdown') }).strict()
])
export type TerminalHostCommand = z.infer<typeof terminalHostCommandSchema>
