import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { MobileConversationSnapshot } from '../../../shared/mobile-gateway'
import type { MobileHomeGroup, MobileHomeSession } from '../../../shared/mobile-list'
import { MOBILE_SECURITY_COPY } from '../../../shared/mobile-gateway'
import { createMobileLiveSubscriber } from '../../../shared/mobile-live-subscriber'
import { ResolvedThemeOverride } from '../store/theme'
import { deviceToken, mobileApi, onTokenChange, pairFromLocation } from './api'
import { SessionList } from './SessionList'
import { ChatPane } from './ChatPane'
import { ThemeButton } from './ThemeButton'
import { useMobileTheme } from './theme'

const message = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason)

function useRoute(): [string, (next: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/')
  useEffect(() => {
    const update = (): void => setRoute(location.hash.slice(1) || '/')
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  const go = useCallback((next: string) => {
    if (location.hash.slice(1) !== next) location.hash = next
    setRoute(next)
  }, [])
  return [route, go]
}

export function MobileApp(): React.JSX.Element {
  const theme = useMobileTheme()
  const token = useSyncExternalStore(onTokenChange, deviceToken)
  const [route, go] = useRoute()
  const [booted, setBooted] = useState(false)
  const [groups, setGroups] = useState<MobileHomeGroup[]>([])
  const [host, setHost] = useState(location.hostname)
  const [listError, setListError] = useState('')
  const [chatError, setChatError] = useState('')
  const [snapshot, setSnapshot] = useState<MobileConversationSnapshot | null>(null)
  const [paused, setPaused] = useState(false)
  const routedWorker = route.startsWith('/s/') ? route.slice(3) : null

  const live = useMemo(
    () =>
      createMobileLiveSubscriber({
        source: (workerId) => mobileApi.events(workerId),
        fetch: (workerId) => mobileApi.snapshot(workerId),
        snapshot: (value) => {
          setSnapshot(value)
          setChatError('')
        },
        finished: () => navigator.vibrate?.(40),
        paused: setPaused,
        error: (reason) => setChatError(message(reason))
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

  const open = useCallback(
    (session: MobileHomeSession) => {
      void live.navigate(
        () =>
          session.workerId
            ? mobileApi.snapshot(session.workerId)
            : mobileApi.open(session.cwd, session.sessionPath ?? undefined),
        (next) => {
          setSnapshot(next)
          setChatError('')
          go(`/s/${next.workerId}`)
          live.watch(next.workerId)
          void loadList()
        }
      )
    },
    [live, go, loadList]
  )

  if (!token)
    return (
      <ResolvedThemeOverride.Provider value={theme.resolved}>
        <div className="m-auth">
          <header className="m-top">
            <h1>Pi 远程对话</h1>
            <ThemeButton choice={theme.choice} onChoice={theme.setChoice} />
          </header>
          <div className="m-notice">
            <p>{MOBILE_SECURITY_COPY}</p>
          </div>
          <p className="m-empty">
            请在桌面设置 ›
            手机中显示配对码，用这台设备扫描。网关只在本机回环和当前局域网私网地址上监听。
          </p>
          {listError ? (
            <p className="m-notice is-error" role="alert">
              {listError}
            </p>
          ) : null}
        </div>
      </ResolvedThemeOverride.Provider>
    )

  const shown = snapshot && snapshot.workerId === routedWorker ? snapshot : null
  return (
    <ResolvedThemeOverride.Provider value={theme.resolved}>
      <div className="m-app" data-view={routedWorker ? 'chat' : 'list'}>
        <aside className="pane-list">
          <SessionList
            groups={groups}
            host={host}
            error={listError}
            selected={routedWorker}
            theme={theme.choice}
            onTheme={theme.setChoice}
            onRefresh={loadList}
            onOpen={open}
          />
        </aside>
        <section className="pane-chat">
          <ChatPane
            snapshot={shown}
            routed={Boolean(routedWorker)}
            host={host}
            error={chatError}
            paused={paused}
            theme={theme.choice}
            onTheme={theme.setChoice}
            onBack={() => {
              go('/')
              void loadList()
            }}
            onRefresh={() => void live.refresh()}
            onError={setChatError}
          />
        </section>
      </div>
    </ResolvedThemeOverride.Provider>
  )
}
