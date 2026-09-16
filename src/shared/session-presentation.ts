import type { ProjectInfo, SessionStatus, SessionSummary } from './contracts'
import { textContextSummary } from './text-attachments'

const NEW_SESSION_TITLE = '新会话'
const EMPTY_SESSION_FIRST_MESSAGE = '(no messages)'

export function canCreateSession(project: ProjectInfo | null): boolean {
  return project !== null
}

export function projectSessionTitle(session: { name?: string; firstMessage: string }): string {
  const name = session.name?.trim()
  const candidate = textContextSummary(session.firstMessage).trim()
  const firstMessage = candidate === EMPTY_SESSION_FIRST_MESSAGE ? '' : candidate
  if (name && (name !== NEW_SESSION_TITLE || !firstMessage)) return name
  const line = firstMessage.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ')
  const characters = [...line]
  return characters.length > 48 ? `${characters.slice(0, 48).join('')}…` : line || NEW_SESSION_TITLE
}

export function activeSessionTitle(
  activeSessionPath: string | null,
  sessions: readonly SessionSummary[]
): string {
  return sessions.find((session) => session.path === activeSessionPath)?.title ?? NEW_SESSION_TITLE
}

const STATUS_DISPLAY: Record<SessionStatus, { tone: SessionStatus; label: string }> = {
  idle: { tone: 'idle', label: '空闲' },
  running: { tone: 'running', label: '运行中' },
  'awaiting-approval': { tone: 'awaiting-approval', label: '等待确认' },
  error: { tone: 'error', label: '出错' },
  stopped: { tone: 'stopped', label: '已停止' }
}

export function sessionStatusDisplay(status: SessionStatus): {
  tone: SessionStatus
  label: string
} {
  return STATUS_DISPLAY[status]
}

export function activeSessionHeader(
  activeSessionPath: string | null,
  sessions: readonly SessionSummary[],
  status: SessionStatus
): {
  title: string
  status: { tone: SessionStatus; label: string }
} {
  return {
    title: activeSessionTitle(activeSessionPath, sessions),
    status: sessionStatusDisplay(status)
  }
}

export function projectedSessionStatus(
  sessionPath: string,
  activeSessionPath: string | null,
  activeStatus: SessionStatus
): SessionStatus {
  return sessionPath === activeSessionPath ? activeStatus : 'idle'
}
