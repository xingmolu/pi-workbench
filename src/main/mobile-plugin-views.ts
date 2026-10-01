import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type {
  MobilePluginCallResult,
  MobilePluginView,
  RemoteViewAccess
} from '../shared/remote-views'
import type { PluginPanelContext } from '../shared/workbench-contracts'
import { PLUGIN_HOST_METHODS, PluginApiError } from '../shared/plugin-api'
import type { MobilePluginViewSource } from './workbench-host-state'

/** What the gateway needs from the desktop's plugin host. */
export type MobilePluginSource = {
  views(): MobilePluginViewSource[]
  context(viewId: string): PluginPanelContext
  call(
    viewId: string,
    method: string,
    params: unknown,
    approve: (request: { title: string; detail: string }) => Promise<boolean>
  ): Promise<unknown>
}

/** Reads work while the phone may only watch; anything that changes the machine needs control. */
const READ_METHODS = new Set([
  'storage.get',
  'project.current',
  'workspace.get',
  'plugin.getSettings',
  'app.getAppearance',
  'fs.list',
  'fs.stat',
  'fs.readText',
  'git.status',
  'git.diff',
  'git.log'
])
const CONTROL_METHODS = new Set([
  'storage.set',
  'fs.writeText',
  'git.stage',
  'git.unstage',
  'git.discard',
  'git.commit',
  'git.push'
])

export function mobileMethodAccess(method: string): 'view' | 'control' | null {
  if (!Object.hasOwn(PLUGIN_HOST_METHODS, method)) return null
  if (READ_METHODS.has(method)) return 'view'
  if (CONTROL_METHODS.has(method)) return 'control'
  // Desktop-only effects (reveal a view, write the desktop clipboard, register tools).
  return null
}

export const mobilePluginOpenSchema = z.object({ viewId: z.string().min(1).max(256) }).strict()
export const mobilePluginCallSchema = z
  .object({
    viewId: z.string().min(1).max(256),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
    /** Answers an earlier `confirm` response for exactly this call. */
    confirm: z.string().min(16).max(128).optional()
  })
  .strict()

const FRAME_TTL_MS = 30 * 60_000
const CONFIRM_TTL_MS = 2 * 60_000
export const MOBILE_PLUGIN_FRAME_PREFIX = '/plugin-frame/'
const BRIDGE_FILE = '__pi_mobile_bridge.js'

/**
 * Frames run with an opaque origin: they can load their own files and talk to the phone page
 * through `postMessage`, never to the gateway's API or the paired device's cookie.
 */
export const MOBILE_PLUGIN_FRAME_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms"

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}
const MAX_FILE_BYTES = 8 * 1024 * 1024

type Frame = { deviceId: string; viewId: string; root: string; expires: number }
type Confirmation = { deviceId: string; key: string; expires: number }

function within(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!!child && !child.startsWith('..') && !isAbsolute(child))
}

function callKey(viewId: string, method: string, params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([viewId, method, params ?? {}]))
    .digest('hex')
}

/**
 * Plugin pages on the phone: short-lived frame URLs for their files, and one call path that
 * reuses the desktop's plugin gateway with the phone's access level and confirmations.
 */
export class MobilePluginViews {
  private readonly frames = new Map<string, Frame>()
  private readonly confirmations = new Map<string, Confirmation>()
  constructor(
    private readonly source: MobilePluginSource,
    private readonly now: () => number = Date.now
  ) {}

  list(): MobilePluginView[] {
    return this.source.views().map((view) => ({
      id: view.id,
      pluginId: view.pluginId,
      pluginName: view.pluginName,
      title: view.title,
      available: view.available
    }))
  }

  open(deviceId: string, viewId: string): { url: string; context: PluginPanelContext } {
    const view = this.source.views().find((item) => item.id === viewId)
    if (!view) throw new PluginApiError('NOT_FOUND', '这个插件页面没有开放给手机')
    if (!view.available) throw new PluginApiError('NOT_FOUND', '请先在电脑上打开一个项目')
    this.sweep()
    const token = randomBytes(24).toString('base64url')
    this.frames.set(token, {
      deviceId,
      viewId,
      root: view.root,
      expires: this.now() + FRAME_TTL_MS
    })
    const entry = relative(view.root, view.entryPath).split(sep).map(encodeURIComponent).join('/')
    return {
      url: `${MOBILE_PLUGIN_FRAME_PREFIX}${token}/${entry}`,
      context: this.source.context(viewId)
    }
  }

  context(viewId: string): PluginPanelContext {
    if (!this.source.views().some((item) => item.id === viewId))
      throw new PluginApiError('NOT_FOUND', '这个插件页面没有开放给手机')
    return this.source.context(viewId)
  }

  async call(
    deviceId: string,
    access: RemoteViewAccess,
    request: z.infer<typeof mobilePluginCallSchema>
  ): Promise<MobilePluginCallResult> {
    const needed = mobileMethodAccess(request.method)
    if (!needed) return { ok: false, code: 'UNSUPPORTED', message: '手机端不支持这个操作' }
    if (access === 'off')
      return { ok: false, code: 'PERMISSION_DENIED', message: '电脑未开放远程工作台' }
    if (needed === 'control' && access !== 'control')
      return { ok: false, code: 'PERMISSION_DENIED', message: '电脑只允许查看，不允许远程操作。' }
    this.sweep()
    const key = callKey(request.viewId, request.method, request.params)
    let asked = null as { title: string; detail: string } | null
    const approve = async (prompt: { title: string; detail: string }): Promise<boolean> => {
      const answer = request.confirm ? this.confirmations.get(request.confirm) : undefined
      if (answer && answer.deviceId === deviceId && answer.key === key) {
        this.confirmations.delete(request.confirm!)
        return true
      }
      asked = { title: prompt.title, detail: prompt.detail }
      return false
    }
    try {
      const value = await this.source.call(request.viewId, request.method, request.params, approve)
      const json = value === undefined ? undefined : JSON.parse(JSON.stringify(value))
      return json === undefined ? { ok: true } : { ok: true, value: json }
    } catch (error) {
      if (asked) {
        // Nothing ran: the host asks before it acts. The phone confirms, then repeats the call.
        const token = randomBytes(24).toString('base64url')
        this.confirmations.set(token, { deviceId, key, expires: this.now() + CONFIRM_TTL_MS })
        const { title, detail } = asked
        return { ok: false, confirm: { token, title, detail } }
      }
      const code =
        error instanceof PluginApiError
          ? error.code
          : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'INTERNAL'
      const message = error instanceof Error ? error.message.slice(0, 2000) : '宿主处理失败'
      return { ok: false, code, message }
    }
  }

  /** A file of an opened frame, or null when the token or path is not one of its own. */
  async file(
    pathname: string
  ): Promise<{ status: number; type: string; body: Buffer | string } | null> {
    if (!pathname.startsWith(MOBILE_PLUGIN_FRAME_PREFIX)) return null
    const rest = pathname.slice(MOBILE_PLUGIN_FRAME_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    const token = rest.slice(0, slash)
    const frame = this.frames.get(token)
    if (!frame || frame.expires < this.now()) return null
    if (!this.source.views().some((view) => view.id === frame.viewId && view.root === frame.root))
      return null
    let relativePath: string
    try {
      relativePath = rest
        .slice(slash + 1)
        .split('/')
        .map((part) => decodeURIComponent(part))
        .join(sep)
    } catch {
      return null
    }
    if (relativePath === BRIDGE_FILE)
      return { status: 200, type: TYPES['.js']!, body: MOBILE_PLUGIN_BRIDGE_SCRIPT }
    const type = TYPES[extname(relativePath).toLowerCase()]
    if (!type || relativePath.split(sep).some((part) => part === '..' || part.startsWith('.')))
      return null
    let canonical: string
    try {
      canonical = await realpath(join(frame.root, relativePath))
      const info = await stat(canonical)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    } catch {
      return null
    }
    if (!within(frame.root, canonical)) return null
    const body = await readFile(canonical)
    if (!type.startsWith('text/html')) return { status: 200, type, body }
    const bridge = `<script src="${MOBILE_PLUGIN_FRAME_PREFIX}${token}/${BRIDGE_FILE}"></script>`
    const html = body.toString('utf8')
    const head = /<head[^>]*>/i.exec(html)
    return {
      status: 200,
      type,
      body: head
        ? html.slice(0, head.index + head[0].length) +
          bridge +
          html.slice(head.index + head[0].length)
        : bridge + html
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [token, frame] of this.frames) if (frame.expires < now) this.frames.delete(token)
    for (const [token, entry] of this.confirmations)
      if (entry.expires < now) this.confirmations.delete(token)
  }
}

/**
 * `window.piPlugin` inside a phone frame. Every call goes to the phone page by `postMessage`,
 * which forwards it to the gateway with the device's own credentials.
 */
export const MOBILE_PLUGIN_BRIDGE_SCRIPT = `(() => {
  'use strict'
  const pending = new Map()
  const listeners = new Set()
  let sequence = 0
  let context = null
  let panelState = null
  const request = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      window.parent.postMessage(Object.assign({ source: 'pi-plugin', id, type }, payload), '*')
    })
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data
    if (!data || data.source !== 'pi-host') return
    if (data.type === 'context') {
      context = data.context
      for (const listener of [...listeners]) {
        try { listener(context) } catch (error) { console.error(error) }
      }
      return
    }
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.ok) entry.resolve(data.value === undefined ? null : data.value)
    else
      entry.reject(Object.freeze({
        name: 'PluginApiError',
        code: data.code || 'INTERNAL',
        message: data.message || '插件调用失败'
      }))
  })
  const api = Object.freeze({
    surface: 'mobile',
    getContext: () =>
      context ? Promise.resolve(context) : request('context', {}).then((value) => (context = value)),
    getState: async () => panelState,
    setState: async (_generation, value) => { panelState = value },
    call: (method, params) => request('call', { method: String(method), params: params || {} }),
    onContext: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  Object.defineProperty(window, 'piPlugin', { value: api })
  document.documentElement.dataset.piSurface = 'mobile'
})()
`
