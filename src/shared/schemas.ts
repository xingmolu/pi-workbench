import { z } from 'zod'
import type { HostCommand, HostMessage, HostRequest } from './contracts'

const permissionModeSchema = z.enum(['open', 'ask'])

export const hostCommandSchema: z.ZodType<HostCommand> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bootstrap') }),
  z.object({ type: z.literal('state:get') }),
  z.object({ type: z.literal('project:open'), cwd: z.string().min(1) }),
  z.object({
    type: z.literal('session:new'),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional()
  }),
  z.object({ type: z.literal('session:open'), path: z.string().min(1) }),
  z.object({ type: z.literal('prompt:send'), text: z.string().min(1) }),
  z.object({ type: z.literal('prompt:abort') }),
  z.object({ type: z.literal('permission:set'), mode: permissionModeSchema }),
  z.object({
    type: z.literal('permission:respond'),
    requestId: z.string().min(1),
    allow: z.boolean()
  }),
  z.object({
    type: z.literal('account:login'),
    providerId: z.string().min(1),
    method: z.enum(['browser', 'device_code'])
  }),
  z.object({
    type: z.literal('account:login:respond'),
    promptId: z.string().min(1),
    value: z.string().optional()
  }),
  z.object({ type: z.literal('account:alias:add'), slug: z.string().min(1) }),
  z.object({
    type: z.literal('model:set'),
    providerId: z.string().min(1),
    modelId: z.string().min(1)
  })
])

export const hostRequestSchema: z.ZodType<HostRequest> = hostCommandSchema.and(
  z.object({ requestId: z.string().min(1) })
)

export const hostMessageSchema: z.ZodType<HostMessage> = z.union([
  z.object({
    type: z.literal('response'),
    requestId: z.string().min(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional()
  }),
  z.object({
    type: z.literal('event'),
    event: z.enum(['state', 'approval', 'login-prompt', 'open-external']),
    data: z.unknown()
  }) as z.ZodType<HostMessage>
])
