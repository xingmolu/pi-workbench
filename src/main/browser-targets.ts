import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { z } from 'zod'
import { targetCall } from './browser-target-scripts'
import { browserRefSchema } from '../shared/browser-ref'

const WORLD_ID = 1087
const nonceSchema = z.string().uuid()
const tokenSchema = browserRefSchema
const itemSchema = z
  .object({
    token: tokenSchema,
    role: z.string().max(64),
    name: z.string().max(180),
    href: z.string().max(1024),
    type: z.string().max(80)
  })
  .strict()
const snapshotSchema = z
  .object({
    nonce: nonceSchema,
    title: z.string().max(256),
    content: z.string().max(6000),
    text: z.string().max(20000),
    incomplete: z.boolean(),
    items: z.array(itemSchema).max(160)
  })
  .strict()
const pointSchema = z
  .object({
    nonce: nonceSchema,
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  })
  .strict()

/**
 * Main-only adapter for one WebContents. Not an Agent/Renderer script API.
 * The owning manager must invalidate on navigation initiation and enforce its
 * page/action lease across awaits. Renderer execution cannot be withdrawn.
 */
export class BrowserTargets {
  #disposed = false
  constructor(private readonly contents: Pick<WebContents, 'executeJavaScriptInIsolatedWorld'>) {}
  async #call(
    method: Parameters<typeof targetCall>[0],
    argument?: Parameters<typeof targetCall>[1]
  ): Promise<unknown> {
    if (this.#disposed) throw new Error('Browser targets disposed')
    const result: unknown = await this.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [
      { code: targetCall(method, argument) }
    ])
    if (this.#disposed && method !== 'dispose') throw new Error('Browser targets disposed')
    return result
  }
  async snapshot() {
    const nonce = randomUUID()
    const result = snapshotSchema.parse(await this.#call('snapshot', nonce))
    if (
      result.nonce !== nonce ||
      result.items.some(
        (item) => !item.token.startsWith(nonce + ':') || !result.text.includes(JSON.stringify(item))
      )
    )
      throw new Error('Invalid browser snapshot')
    return result
  }
  async locate(token: unknown) {
    const ref = tokenSchema.parse(token)
    const result = pointSchema.parse(await this.#call('locate', ref))
    if (
      !ref.startsWith(result.nonce + ':') ||
      result.x >= result.width ||
      result.y >= result.height
    )
      throw new Error('Invalid browser target point')
    // These are renderer viewport bounds. Before physical input the owner must
    // also validate against its current view bounds. DOM/input is not atomic.
    return result
  }
  async invalidate() {
    z.literal(true).parse(await this.#call('invalidate'))
  }
  async fill(token: unknown, value: unknown) {
    const input = z
      .object({ token: tokenSchema, value: z.string().max(10000) })
      .parse({ token, value })
    z.literal(true).parse(await this.#call('fill', input))
  }
  async select(token: unknown, value: unknown) {
    const input = z
      .object({ token: tokenSchema, value: z.string().max(10000) })
      .parse({ token, value })
    z.literal(true).parse(await this.#call('select', input))
  }
  async dispose() {
    if (this.#disposed) return
    const pending = this.#call('dispose')
    this.#disposed = true
    z.literal(true).parse(await pending)
  }
}
