import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  HostCommand,
  LoginMethod,
  WorkbenchCommand,
  WorkbenchSnapshot
} from '../../shared/contracts'
import Sidebar from './components/Sidebar'
import Conversation from './components/Conversation'
import Workbench from './components/Workbench'
import { modelSelectionCommand, newSessionCommand } from './store/composer-model-selection'
import { usePiStore } from './store/pi-store'
import { startWorkbenchEventCoordinator } from './store/workbench-event-coordinator'
import { INITIAL_WORKBENCH_SELECTION, workbenchSelectionReducer } from './store/workbench-selection'
import { INITIAL_WORKBENCH_STATUS, workbenchStatusReducer } from './store/workbench-status'
import { INITIAL_WORKSPACE_LAYOUT, workspaceLayoutReducer } from './store/workspace-layout'

export default function App(): React.JSX.Element {
  const snapshot = usePiStore((state) => state.snapshot)
  const loading = usePiStore((state) => state.loading)
  const clientError = usePiStore((state) => state.clientError)
  const setSnapshot = usePiStore((state) => state.setSnapshot)
  const applyPatch = usePiStore((state) => state.applyPatch)
  const setClientError = usePiStore((state) => state.setClientError)
  const [layout, dispatchLayout] = useReducer(workspaceLayoutReducer, INITIAL_WORKSPACE_LAYOUT)
  const [workbenchStatus, dispatchWorkbenchStatus] = useReducer(
    workbenchStatusReducer,
    INITIAL_WORKBENCH_STATUS
  )
  const [workbenchSelection, dispatchWorkbenchSelection] = useReducer(
    workbenchSelectionReducer,
    INITIAL_WORKBENCH_SELECTION
  )
  const workbenchRevision = useRef(-1)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)

  const acceptWorkbenchSnapshot = useCallback((state: WorkbenchSnapshot): void => {
    if (state.revision <= workbenchRevision.current) return
    workbenchRevision.current = state.revision
    dispatchWorkbenchStatus({ type: 'snapshot', snapshot: state })
    dispatchWorkbenchSelection({ type: 'snapshot', contributions: state.contributions })
  }, [])

  const reportWorkbenchError = useCallback((message: string): void => {
    dispatchWorkbenchStatus({ type: 'error', message })
  }, [])

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
  }, [applyPatch, setClientError, setSnapshot])

  useEffect(
    () =>
      startWorkbenchEventCoordinator({
        subscribe: window.pi.onWorkbenchEvent,
        getState: () => window.pi.workbench({ type: 'state:get' }),
        onSnapshot: acceptWorkbenchSnapshot,
        onReveal: (viewId) => {
          dispatchWorkbenchSelection({ type: 'reveal', viewId })
          dispatchLayout({ type: 'settings:close' })
          setWorkbenchOpen(true)
        },
        onError: reportWorkbenchError
      }),
    [acceptWorkbenchSnapshot, reportWorkbenchError]
  )

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

  const sendWorkbench = useCallback(
    async (command: WorkbenchCommand): Promise<void> => {
      const result = await window.pi.workbench(command)
      dispatchWorkbenchStatus({ type: 'clear' })
      acceptWorkbenchSnapshot(result.state)
    },
    [acceptWorkbenchSnapshot]
  )

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
        selectedViewId={workbenchSelection.selectedViewId}
        settingsOpen={layout.settingsOpen}
        agentSnapshot={snapshot}
        workbenchSnapshot={workbenchStatus.snapshot}
        workbenchError={workbenchStatus.error}
        onSelectView={(viewId) => {
          closeSettings()
          dispatchWorkbenchSelection({ type: 'select', viewId })
          setWorkbenchOpen(true)
        }}
        onToggle={() => {
          if (layout.settingsOpen) closeSettings()
          else setWorkbenchOpen(false)
        }}
        onWorkbenchCommand={sendWorkbench}
        onWorkbenchError={reportWorkbenchError}
        onLogin={login}
        onAddAlias={(slug) => void send({ type: 'account:alias:add', slug })}
        onLoginPrompt={(promptId, value) => {
          void send({ type: 'account:login:respond', promptId, value })
        }}
      />
    </div>
  )
}
