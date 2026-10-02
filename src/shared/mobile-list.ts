import type { MobileCatalogProject, MobileSessionListItem } from './mobile-gateway'
import { t } from './i18n'

const ISO_TAIL = /[\s/]*\d{4}-\d{2}-\d{2}T[0-9:.]+Z?\s*$/i

export type MobileHomeSession = {
  key: string
  title: string
  timeLabel: string
  status: string
  workerId: string | null
  cwd: string
  sessionPath: string | null
}

export type MobileHomeGroup = {
  name: string
  path: string
  sessions: MobileHomeSession[]
}

export function stripIsoTimestamp(title: string): string {
  const cleaned = title.replace(ISO_TAIL, '').replace(/\s+/g, ' ').trim()
  return cleaned || title.trim()
}

function pad(value: number | string): string {
  return String(value).padStart(2, '0')
}

function calendarParts(
  date: Date,
  timeZone?: string
): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {})
  }).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute')
  }
}

function shiftDay(
  parts: { year: string; month: string; day: string },
  delta: number
): { year: string; month: string; day: string } {
  const shifted = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + delta)
  )
  return {
    year: String(shifted.getUTCFullYear()),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate())
  }
}

/** Short local/relative time for list rows. Never returns an ISO-8601 `…T…Z` dump. */
export function formatMobileTime(value: string, now: Date = new Date(), timeZone?: string): string {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const target = calendarParts(new Date(ms), timeZone)
  const today = calendarParts(now, timeZone)
  const clock = `${target.hour}:${target.minute}`
  if (target.year === today.year && target.month === today.month && target.day === today.day) {
    return clock
  }
  const yesterday = shiftDay(today, -1)
  if (
    target.year === yesterday.year &&
    target.month === yesterday.month &&
    target.day === yesterday.day
  ) {
    return t('昨天 {clock}', { clock })
  }
  const start = Date.UTC(Number(target.year), Number(target.month) - 1, Number(target.day))
  const todayStart = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day))
  const diffDays = Math.round((todayStart - start) / 86_400_000)
  if (diffDays >= 2 && diffDays < 60) return t('{diffDays}天', { diffDays })
  if (target.year === today.year) return `${target.month}-${target.day}`
  return `${target.year}-${target.month}-${target.day}`
}

export type MobileStatusKind = 'ok' | 'run' | 'ask' | 'err' | 'idle'

export function mobileStatusBadge(status: string): { label: string; kind: MobileStatusKind } {
  if (status === 'running' || status === 'opening') return { label: t('运行中'), kind: 'run' }
  if (status === 'awaiting-approval') return { label: t('等待批准'), kind: 'ask' }
  if (status === 'error') return { label: t('出错'), kind: 'err' }
  if (status === 'idle') return { label: t('已完成'), kind: 'ok' }
  return { label: t('空闲'), kind: 'idle' }
}

export function projectBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path || t('项目')
}

function liveRow(item: MobileSessionListItem): MobileHomeSession {
  return {
    key: item.workerId,
    title: stripIsoTimestamp(item.title),
    timeLabel: '',
    status: item.status,
    workerId: item.workerId,
    cwd: item.cwd,
    sessionPath: item.sessionPath
  }
}

export function buildMobileHomeGroups(
  live: MobileSessionListItem[],
  catalog: MobileCatalogProject[],
  now: Date = new Date(),
  timeZone?: string
): MobileHomeGroup[] {
  const used = new Set<string>()
  const liveByPath = new Map<string, MobileSessionListItem>()
  for (const item of live) {
    if (item.sessionPath) liveByPath.set(item.sessionPath, item)
  }

  const groups: MobileHomeGroup[] = []
  for (const project of catalog) {
    const sessions: MobileHomeSession[] = []
    for (const item of live) {
      if (item.cwd !== project.path) continue
      if (item.sessionPath && project.sessions.some((session) => session.path === item.sessionPath))
        continue
      used.add(item.workerId)
      sessions.push(liveRow(item))
    }
    for (const session of project.sessions) {
      const liveHit = liveByPath.get(session.path)
      if (liveHit) used.add(liveHit.workerId)
      sessions.push({
        key: liveHit?.workerId ?? session.path,
        title: stripIsoTimestamp(liveHit?.title || session.title),
        timeLabel: formatMobileTime(session.modified, now, timeZone),
        status: liveHit?.status ?? session.status,
        workerId: liveHit?.workerId ?? null,
        cwd: project.path,
        sessionPath: session.path
      })
    }
    if (sessions.length) {
      groups.push({
        name: project.name || projectBasename(project.path),
        path: project.path,
        sessions
      })
    }
  }

  const leftover = new Map<string, MobileSessionListItem[]>()
  for (const item of live) {
    if (used.has(item.workerId)) continue
    const bucket = leftover.get(item.cwd) ?? []
    bucket.push(item)
    leftover.set(item.cwd, bucket)
  }
  const extra: MobileHomeGroup[] = []
  for (const [cwd, items] of leftover) {
    extra.push({
      name: projectBasename(cwd),
      path: cwd,
      sessions: items.map((item) => liveRow(item))
    })
  }
  return [...extra, ...groups]
}

export function filterMobileHomeGroups(
  groups: MobileHomeGroup[],
  query: string
): MobileHomeGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return groups
  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter(
        (session) =>
          session.title.toLocaleLowerCase().includes(needle) ||
          group.name.toLocaleLowerCase().includes(needle)
      )
    }))
    .filter((group) => group.sessions.length > 0)
}
