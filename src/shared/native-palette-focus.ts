import { z } from 'zod'
export const NATIVE_PALETTE_FOCUS_CHANNEL = 'pi:palette-focus'
export const nativePaletteFocusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('finish'), token: z.string().uuid(), restore: z.boolean() }).strict(),
  z.object({ type: z.literal('invalidate') }).strict()
])
export type NativePaletteFocusCommand = z.infer<typeof nativePaletteFocusSchema>
