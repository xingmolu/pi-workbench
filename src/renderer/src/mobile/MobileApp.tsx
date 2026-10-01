import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MobileConversationSnapshot } from '../../../shared/mobile-gateway'
import type { MobileHomeGroup, MobileHomeSession } from '../../../shared/mobile-list'
import {
  createMobileLiveSubscriber,
  type MobileConnection
} from '../../../shared/mobile-live-subscriber'
import { approvalSummary } from '../store/conversation-presentation'
import { ResolvedThemeOverride } from '../store/theme'
import { ApiError, deviceToken, mobileApi, onTokenChange, pairFromLocation } from './api'
import { SessionList } from './SessionList'
import { ChatPane } from './ChatPane'
import { PairingScreen } from './PairingScreen'
import { useMobileTheme } from './theme'
import { notifyInBackground, useNotifications } from './notify'
import { formatRoute, parseRoute, type MobileRoute } from './route'
import { WorkbenchPane } from './WorkbenchPane'

const message = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason)

/** Navigation failures must not look like "the displayed session is gone". */
const plain = <T,>(task: Promise<T>): Promise<T> =>
  task.catch((reason: unknown) => {
    throw new Error(message(reason))
  })

const RETRY_DELAYS = [1000, 2000, 5000, 10000]

function useRoute(): [MobileRoute, (next: MobileRoute, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const update = (): void => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  const go = useCallback((next: MobileRoute, replace = false) => {
    const hash = `#${formatRoute(next)}`
    if (location.hash !== hash) {
      // Replacing keeps Back from returning to a session link that no longer works.
      if (replace) history.replaceState(history.state, '', hash)
      else location.hash = hash
    }
    setRoute(next)
  }, [])
  return [route, go]
}

function lastReply(snapshot: MobileConversationSnapshot): string {
  const node = snapshot.nodes.findLast((item) => item.type === 'assistant')
  return node?.type === 'assistant' ? node.markdown.replace(/\s+/g, ' ').slice(0, 140) : ''
}

export function MobileApp(): React.JSX.Element {
  const theme = useMobileTheme()
  const notifications = useNotifications()
  const token = useSyncExternalStore(onTokenChange, deviceToken)
  const [route, go] = useRoute()
  const [booted, setBooted] = useState(false)
  const [groups, setGroups] = useState<MobileHomeGroup[]>([])
  const [host, setHost] = useState(location.hostname)
  const [listError, setListError] = useState('')
  const [chatError, setChatError] = useState('')
  const [snapshot, setSnapshot] = useState<MobileConversationSnapshot | null>(null)
  const [paused, setPaused] = useState(false)
  const [connection, setConnection] = useState<MobileConnection>('live')
  const routedWorker = route.view === 'session' ? route.workerId : null
  const routeRef = useRef(route)
  routeRef.current = route
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const recovering = useRef<string | null>(null)
  const recoverRef = useRef<() => void>(() => {})

  const live = useMemo(
    () =>
      createMobileLiveSubscriber({
        source: (workerId) => mobileApi.events(workerId),
        fetch: (workerId) => mobileApi.snapshot(workerId),
        snapshot: (value) => {
          setSnapshot(value)
          setChatError('')
        },
        finished: () => {
          navigator.vibrate?.(40)
          const current = snapshotRef.current
          if (current)
            void notifyInBackground(
              `${current.title} · 已完成`,
              lastReply(current) || '任务已结束',
              current.workerId
            )
        },
        paused: setPaused,
        connection: setConnection,
        error: (reason) => {
          if (reason instanceof ApiError && reason.status === 404) recoverRef.current()
          else setChatError(message(reason))
        }
      }),
    []
  )

  const loadList = useCallback(async () => {
    try {
      const data = await mobileApi.list()
      setHost(data.host || location.hostname)
      setGroups(data.groups ?? [])
      setListError('')
    } catch (reason) {
      setListError(message(reason))
    }
  }, [])

  const select = useCallback(
    (load: () => Promise<MobileConversationSnapshot>, replace = false) => {
      void live.navigate(load, (next) => {
        setSnapshot(next)
        setChatError('')
        go(
          {
            view: 'session',
            workerId: next.workerId,
            cwd: next.cwd,
            ...(next.sessionPath ? { path: next.sessionPath } : {})
          },
          replace
        )
        live.watch(next.workerId)
        void loadList()
      })
    },
    [live, go, loadList]
  )

  // The worker behind a link is gone (desktop restart, idle eviction): reopen its session
  // file once, under the new worker, instead of showing "not running" forever.
  recoverRef.current = () => {
    const current = routeRef.current
    if (current.view !== 'session') return
    if (!current.path || !current.cwd || recovering.current === current.workerId) {
      setChatError('这个会话已不在桌面上运行。请返回列表重新打开。')
      return
    }
    recovering.current = current.workerId
    const { cwd, path } = current
    select(() => plain(mobileApi.open(cwd, path)), true)
  }

  useEffect(() => {
    void (async () => {
      try {
        await pairFromLocation()
      } catch (reason) {
        setListError(message(reason))
      }
      if (deviceToken()) await loadList()
      setBooted(true)
    })()
  }, [loadList])

  // The route owns the live subscription: a session route watches it, anything else stops.
  useEffect(() => {
    if (!booted || !token) return
    if (!routedWorker) {
      live.stop()
      setSnapshot(null)
      return
    }
    live.watch(routedWorker)
    void live.refresh()
  }, [booted, token, routedWorker, live])
  useEffect(() => () => void live.stop(), [live])

  // Old links carried only the worker; record the session file as soon as it is known.
  const knownPath = snapshot?.workerId === routedWorker ? snapshot?.sessionPath : undefined
  useEffect(() => {
    const current = routeRef.current
    const cwd = snapshotRef.current?.cwd
    if (current.view !== 'session' || !knownPath || current.path === knownPath || !cwd) return
    go({ ...current, cwd, path: knownPath }, true)
  }, [knownPath, go])

  // A dropped stream: the browser retries network errors itself; a closed one is ours.
  const attempts = useRef(0)
  useEffect(() => {
    if (connection === 'live') {
      attempts.current = 0
      return
    }
    if (connection !== 'closed' || !routedWorker) return
    const delay = RETRY_DELAYS[Math.min(attempts.current, RETRY_DELAYS.length - 1)]!
    attempts.current++
    const timer = setTimeout(() => void live.reconnect(), delay)
    return () => clearTimeout(timer)
  }, [connection, routedWorker, live])

  // Phones freeze background pages; catch up as soon as the page is seen again.
  useEffect(() => {
    const resume = (): void => {
      if (document.hidden || !deviceToken()) return
      if (routeRef.current.view === 'session') void live.reconnect()
      else void loadList()
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('online', resume)
    }
  }, [live, loadList])

  // Approvals are what a reader away from the page most needs to know about.
  const approvals = snapshot?.approvals
  const seenApprovals = useRef(new Set<string>())
  useEffect(() => {
    const current = snapshotRef.current
    for (const approval of approvals ?? []) {
      if (seenApprovals.current.has(approval.id)) continue
      seenApprovals.current.add(approval.id)
      if (current)
        void notifyInBackground(
          `${current.title} · 需要确认`,
          approvalSummary(approval),
          approval.id
        )
    }
  }, [approvals])

  const shown = snapshot && snapshot.workerId === routedWorker ? snapshot : null
  useEffect(() => {
    document.title = !shown
      ? 'Pi 远程对话'
      : shown.approvals.length
        ? `需要确认 · ${shown.title}`
        : shown.busy
          ? `运行中 · ${shown.title}`
          : shown.title
  }, [shown])

  const open = useCallback(
    (session: MobileHomeSession) =>
      select(() =>
        plain(
          session.workerId
            ? mobileApi.snapshot(session.workerId)
            : mobileApi.open(session.cwd, session.sessionPath ?? undefined)
        )
      ),
    [select]
  )
  const newSession = useCallback(
    (cwd: string, model?: { providerId: string; modelId: string }) =>
      select(() => plain(mobileApi.newSession(cwd, model))),
    [select]
  )

  if (!token)
    return (
      <ResolvedThemeOverride.Provider value={theme.resolved}>
        <PairingScreen theme={theme} error={listError} onError={setListError} />
      </ResolvedThemeOverride.Provider>
    )

  return (
    <ResolvedThemeOverride.Provider value={theme.resolved}>
      <div
        className="m-app"
        data-view={routedWorker || route.view === 'workbench' ? 'chat' : 'list'}
      >
        <aside className="pane-list">
          <SessionList
            groups={groups}
            host={host}
            error={listError}
            selected={routedWorker}
            theme={theme.choice}
            onTheme={theme.setChoice}
            notifications={notifications}
            onRefresh={loadList}
            onOpen={open}
            onNewSession={(cwd) => newSession(cwd)}
            onWorkbench={() => go({ view: 'workbench' })}
          />
        </aside>
        <section className="pane-chat">
          {route.view === 'workbench' ? (
            <WorkbenchPane
              viewId={route.viewId}
              theme={theme.resolved}
              onSelect={(viewId) =>
                go(viewId ? { view: 'workbench', viewId } : { view: 'workbench' }, true)
              }
              onBack={() => {
                if (history.length > 1) history.back()
                else go({ view: 'list' })
              }}
            />
          ) : (
            <ChatPane
              snapshot={shown}
              routed={Boolean(routedWorker)}
              host={host}
              error={chatError}
              paused={paused}
              offline={Boolean(routedWorker) && connection !== 'live' && !paused}
              theme={theme.choice}
              onTheme={theme.setChoice}
              onBack={() => {
                go({ view: 'list' })
                void loadList()
              }}
              onRefresh={() => void live.refresh()}
              onError={setChatError}
              onNewSession={newSession}
              onWorkbench={() => go({ view: 'workbench' })}
            />
          )}
        </section>
      </div>
    </ResolvedThemeOverride.Provider>
  )
}
