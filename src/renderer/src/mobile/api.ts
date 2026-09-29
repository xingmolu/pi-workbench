import type { PermissionMode, PromptImage, ThinkingLevel } from '../../../shared/contracts'
import type { CheckpointPlan, CheckpointRestoreOutcome } from '../../../shared/checkpoints'
import type { MobileConversationSnapshot } from '../../../shared/mobile-gateway'
import type { SkillSummary } from '../../../shared/skills'
import type {
  RemoteBrowserInput,
  RemoteTerminalInput,
  RemoteViewAccess,
  RemoteViewSummary
} from '../../../shared/remote-views'
import type { MobileHomeGroup } from '../../../shared/mobile-list'

const TOKEN_KEY = 'pi-desktop-device-token'

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

let token = read(TOKEN_KEY)
const listeners = new Set<() => void>()

export function deviceToken(): string {
  return token
}

export function onTokenChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The cookie lets EventSource (which cannot send headers) authenticate too. */
export function persistToken(value: string): void {
  token = value
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* Private mode: the cookie still carries this visit. */
  }
  document.cookie = value
    ? `pi_device=${encodeURIComponent(value)}; Path=/; SameSite=Lax`
    : 'pi_device=; Path=/; Max-Age=0; SameSite=Lax'
  for (const listener of listeners) listener()
}
if (token) persistToken(token)

/** A gateway answer that is not OK; `status` 404 on a session means its worker is gone. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) {
    persistToken('')
    throw new ApiError('尚未配对或设备已被撤销', 401)
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new ApiError(data.error || `请求失败 ${response.status}`, response.status)
  return data as T
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** Exchanges a `?pair=` code from the desktop's QR for a device token. */
export async function pairFromLocation(): Promise<void> {
  const pair = new URLSearchParams(location.search).get('pair')
  if (!pair) return
  await pair_(pair)
  history.replaceState({}, '', `/${location.hash}`)
}

/** The code typed from the desktop's settings, e.g. inside an installed home-screen app. */
export function pairWithCode(code: string): Promise<void> {
  return pair_(code.replace(/[\s-]/g, '').toUpperCase())
}

async function pair_(pair: string): Promise<void> {
  const response = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: pair, deviceName: navigator.userAgent.slice(0, 64) || '手机' })
  })
  const grant = (await response.json().catch(() => ({}))) as {
    deviceToken?: string
    error?: string
  }
  if (!response.ok || !grant.deviceToken) throw new Error(grant.error || '配对失败')
  persistToken(grant.deviceToken)
}

const identity = (
  snapshot: MobileConversationSnapshot
): { sessionId: string | null; generation: number } => ({
  sessionId: snapshot.sessionId,
  generation: snapshot.generation
})

const session = (workerId: string, action = ''): string =>
  `/api/sessions/${encodeURIComponent(workerId)}${action ? `/${action}` : ''}`

export const mobileApi = {
  list: () => api<{ host?: string; groups?: MobileHomeGroup[] }>('/api/sessions'),
  snapshot: (workerId: string) => api<MobileConversationSnapshot>(session(workerId)),
  open: (cwd: string, sessionPath?: string) =>
    post<MobileConversationSnapshot>('/api/sessions/open', { cwd, sessionPath }),
  events: (workerId: string) => new EventSource(session(workerId, 'events')),
  newSession: (cwd: string, model?: { providerId: string; modelId: string }) =>
    post<MobileConversationSnapshot>('/api/sessions/new', { cwd, ...model }),
  send: (snapshot: MobileConversationSnapshot, text: string, images?: PromptImage[]) =>
    post(session(snapshot.workerId, 'send'), {
      ...identity(snapshot),
      text,
      ...(images?.length ? { images } : {})
    }),
  setModel: (snapshot: MobileConversationSnapshot, providerId: string, modelId: string) =>
    post(session(snapshot.workerId, 'model'), { ...identity(snapshot), providerId, modelId }),
  setThinking: (snapshot: MobileConversationSnapshot, level: ThinkingLevel) =>
    post(session(snapshot.workerId, 'thinking'), { ...identity(snapshot), level }),
  setPermission: (workerId: string, mode: PermissionMode) =>
    post(session(workerId, 'permission'), { mode }),
  skills: (snapshot: MobileConversationSnapshot) =>
    post<{ skills: SkillSummary[] }>(session(snapshot.workerId, 'skills'), identity(snapshot)),
  checkpointPlan: (snapshot: MobileConversationSnapshot, entryId: string) =>
    post<{ plan: CheckpointPlan | null }>(session(snapshot.workerId, 'checkpoint'), {
      ...identity(snapshot),
      entryId
    }),
  checkpointRestore: (snapshot: MobileConversationSnapshot, entryId: string, force: boolean) =>
    post<{ outcome: CheckpointRestoreOutcome | null }>(session(snapshot.workerId, 'checkpoint'), {
      ...identity(snapshot),
      entryId,
      restore: true,
      force
    }),
  views: () => api<{ access: RemoteViewAccess; views: RemoteViewSummary[] }>('/api/views'),
  viewEvents: (id: string) => new EventSource(`/api/views/${encodeURIComponent(id)}/events`),
  viewInput: (id: string, input: RemoteBrowserInput | RemoteTerminalInput) =>
    post(`/api/views/${encodeURIComponent(id)}/input`, input),
  abort: (workerId: string) => post(session(workerId, 'abort'), {}),
  clearQueue: (workerId: string) => post(session(workerId, 'queue/clear'), {}),
  respond: (workerId: string, approvalId: string, allow: boolean) =>
    post(session(workerId, 'approval'), { approvalId, allow })
}
