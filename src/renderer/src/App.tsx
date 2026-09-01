import { useCallback, useEffect, useReducer, useState } from 'react'
import type { HostCommand, LoginMethod } from '../../shared/contracts'
import Sidebar from './components/Sidebar'
import Conversation from './components/Conversation'
import Workbench, { type WorkbenchMode } from './components/Workbench'
import { modelSelectionCommand, newSessionCommand } from './store/composer-model-selection'
import { usePiStore } from './store/pi-store'
import { INITIAL_WORKSPACE_LAYOUT, workspaceLayoutReducer } from './store/workspace-layout'

export default function App(): React.JSX.Element {
  const snapshot = usePiStore((state) => state.snapshot)
  const loading = usePiStore((state) => state.loading)
  const clientError = usePiStore((state) => state.clientError)
  const setSnapshot = usePiStore((state) => state.setSnapshot)
  const applyPatch = usePiStore((state) => state.applyPatch)
  const setClientError = usePiStore((state) => state.setClientError)
  const [layout, dispatchLayout] = useReducer(workspaceLayoutReducer, INITIAL_WORKSPACE_LAYOUT)
  const [mode, setMode] = useState<WorkbenchMode>('files')
  const [workbenchOpen, setWorkbenchOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.pi.onEvent((event) => {
      if (event.event === 'snapshot') setSnapshot(event.data)
      if (event.event === 'patch' && applyPatch(event.data) === 'needsSnapshot') {
        void window.pi
          .getState()
          .then((state) => {
            if (!cancelled) setSnapshot(state)
          })
          .catch((error: unknown) => {
            if (!cancelled) setClientError(error instanceof Error ? error.message : String(error))
          })
      }
    })
    const unsubscribeBrowser = window.pi.onBrowserEvent((event) => {
      if (event.type !== 'agent-open') return
      dispatchLayout({ type: 'settings:close' })
      setMode('browser')
      setWorkbenchOpen(true)
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
      unsubscribeBrowser()
    }
  }, [applyPatch, setClientError, setSnapshot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        dispatchLayout({ type: 'sidebar:toggle' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const send = useCallback(
    async (command: HostCommand): Promise<void> => {
      try {
        const result = await window.pi.send(command)
        if (result.kind === 'snapshot') setSnapshot(result.snapshot)
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

  const openSettings = useCallback((): void => {
    setWorkbenchOpen(false)
    dispatchLayout({ type: 'settings:open' })
  }, [])

  const closeSettings = useCallback((): void => {
    dispatchLayout({ type: 'settings:close' })
  }, [])

  const login = useCallback(
    (providerId: string, method: LoginMethod): void => {
      void send({ type: 'account:login', providerId, method })
    },
    [send]
  )

  const respondToApproval = useCallback(
    (id: string, allow: boolean): void => {
      void send({ type: 'permission:respond', approvalId: id, allow })
    },
    [send]
  )

  return (
    <div className="shell">
      <Sidebar
        collapsed={layout.sidebarCollapsed}
        collapseLocked={layout.settingsOpen}
        snapshot={snapshot}
        onToggle={() => dispatchLayout({ type: 'sidebar:toggle' })}
        onChooseProject={() => void chooseProject()}
        onNewSession={() => void send(newSessionCommand(snapshot))}
        onOpenSession={(path) => void send({ type: 'session:open', path })}
        onOpenSettings={openSettings}
      />

      <Conversation
        snapshot={snapshot}
        approvals={snapshot.approvals}
        loading={loading}
        error={snapshot.error ?? clientError}
        onChooseProject={() => void chooseProject()}
        onSend={(text) => void send({ type: 'prompt:send', text })}
        onAbort={() => void send({ type: 'prompt:abort' })}
        onClearQueue={() => void send({ type: 'queue:clear' })}
        onPermissionChange={(permission) => void send({ type: 'permission:set', mode: permission })}
        onChooseModel={(providerId, modelId) =>
          void send(modelSelectionCommand(providerId, modelId))
        }
        onLogin={() => {
          openSettings()
          login('openai-codex', 'browser')
        }}
        onOpenSettings={openSettings}
        onApproval={respondToApproval}
      />

      <Workbench
        collapsed={!layout.settingsOpen && !workbenchOpen}
        mode={mode}
        settingsOpen={layout.settingsOpen}
        snapshot={snapshot}
        onModeChange={(nextMode) => {
          closeSettings()
          setMode(nextMode)
          setWorkbenchOpen(true)
        }}
        onToggle={() => {
          if (layout.settingsOpen) closeSettings()
          else setWorkbenchOpen(false)
        }}
        onCloseSettings={closeSettings}
        onLogin={login}
        onAddAlias={(slug) => void send({ type: 'account:alias:add', slug })}
        onLoginPrompt={(promptId, value) => {
          void send({ type: 'account:login:respond', promptId, value })
        }}
      />
    </div>
  )
}
