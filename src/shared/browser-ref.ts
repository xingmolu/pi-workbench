import { z } from 'zod'

/** A snapshot nonce and bounded slot, never a selector or executable expression. */
export const browserRefSchema = z
  .string()
  .max(40)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:[1-9]|[1-9][0-9]|1[0-5][0-9]|160)$/
  )
