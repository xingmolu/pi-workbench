import { useCallback, useEffect, useState } from 'react'
import type { HostCommand, LoginMethod } from '../../shared/contracts'
import Sidebar from './components/Sidebar'
import Conversation from './components/Conversation'
import Workbench, { type WorkbenchMode } from './components/Workbench'
import { usePiStore } from './store/pi-store'

export default function App(): React.JSX.Element {
  const snapshot = usePiStore((state) => state.snapshot)
  const approval = usePiStore((state) => state.approval)
  const loginPrompt = usePiStore((state) => state.loginPrompt)
  const loading = usePiStore((state) => state.loading)
  const clientError = usePiStore((state) => state.clientError)
  const setSnapshot = usePiStore((state) => state.setSnapshot)
  const setApproval = usePiStore((state) => state.setApproval)
  const setLoginPrompt = usePiStore((state) => state.setLoginPrompt)
  const setClientError = usePiStore((state) => state.setClientError)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<WorkbenchMode>('files')

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.pi.onEvent((event) => {
      if (event.event === 'state') setSnapshot(event.data)
      if (event.event === 'approval') setApproval(event.data)
      if (event.event === 'login-prompt') setLoginPrompt(event.data)
    })

    void window.pi
      .getState()
      .then((state) => {
        if (!cancelled) setSnapshot(state)
      })
      .catch((error: unknown) => {
        if (!cancelled) setClientError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [setApproval, setClientError, setLoginPrompt, setSnapshot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        setSidebarCollapsed((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const send = useCallback(
    async (command: HostCommand): Promise<void> => {
      try {
        setSnapshot(await window.pi.send(command))
      } catch (error) {
        setClientError(error instanceof Error ? error.message : String(error))
      }
    },
    [setClientError, setSnapshot]
  )

  const chooseProject = useCallback(async (): Promise<void> => {
    try {
      const state = await window.pi.selectProject()
      if (state) setSnapshot(state)
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error))
    }
  }, [setClientError, setSnapshot])

  const openSettings = (): void => {
    setSettingsOpen(true)
    setWorkbenchCollapsed(false)
  }

  const login = (providerId: string, method: LoginMethod): void => {
    void send({ type: 'account:login', providerId, method })
  }

  return (
    <div className="shell">
      <Sidebar
        collapsed={sidebarCollapsed}
        snapshot={snapshot}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onChooseProject={() => void chooseProject()}
        onNewSession={() =>
          void send({
            type: 'session:new',
            providerId: snapshot.activeProvider ?? undefined,
            modelId: snapshot.activeModel ?? undefined
          })
        }
        onOpenSession={(path) => void send({ type: 'session:open', path })}
        onOpenSettings={openSettings}
      />

      <Conversation
        snapshot={snapshot}
        approval={approval}
        loading={loading}
        error={snapshot.error ?? clientError}
        onSend={(text) => void send({ type: 'prompt:send', text })}
        onAbort={() => void send({ type: 'prompt:abort' })}
        onPermissionChange={(permission) => void send({ type: 'permission:set', mode: permission })}
        onChooseAccount={(providerId, modelId) => {
          const hasConversation = snapshot.nodes.some((node) => node.type === 'user')
          void send(
            hasConversation
              ? { type: 'session:new', providerId, modelId }
              : { type: 'model:set', providerId, modelId }
          )
        }}
        onChooseModel={(providerId, modelId) =>
          void send(
            snapshot.nodes.some((node) => node.type === 'user')
              ? { type: 'session:new', providerId, modelId }
              : { type: 'model:set', providerId, modelId }
          )
        }
        onLogin={() => {
          openSettings()
          login('openai-codex', 'browser')
        }}
        onOpenSettings={openSettings}
        onApproval={(id, allow) => {
          setApproval(null)
          void send({ type: 'permission:respond', requestId: id, allow })
        }}
      />

      <Workbench
        collapsed={workbenchCollapsed}
        mode={mode}
        settingsOpen={settingsOpen}
        snapshot={snapshot}
        loginPrompt={loginPrompt}
        onModeChange={(nextMode) => {
          setSettingsOpen(false)
          setMode(nextMode)
        }}
        onToggle={() => setWorkbenchCollapsed((value) => !value)}
        onCloseSettings={() => setSettingsOpen(false)}
        onLogin={login}
        onAddAlias={(slug) => void send({ type: 'account:alias:add', slug })}
        onLoginPrompt={(promptId, value) => {
          setLoginPrompt(null)
          void send({ type: 'account:login:respond', promptId, value })
        }}
      />
    </div>
  )
}
