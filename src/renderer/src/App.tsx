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
import SettingsDialog from './components/SettingsDialog'
import McpSettings from './components/McpSettings'
import SkillsSettings from './components/SkillsSettings'
import { useSkillInsertion } from './store/skill-draft'
import { useTextAttachments } from './store/text-attachments'
import AccountQuota from './components/AccountQuota'
import { modelSelectionCommand } from './store/composer-model-selection'
import { projectNavigationReason } from '../../shared/project-catalog'
import type { ProjectNavigationFailures } from '../../shared/project-catalog'
import { useSessionEdit } from './store/session-edit'
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
  const disconnect = usePiStore((state) => state.disconnect)
  const recover = usePiStore((state) => state.recover)
  const [reconnecting, setReconnecting] = useState(false)
  const navigationLock = useRef(false)
  const navigationAttempt = useRef(0)
  const [navigationFailures, setNavigationFailures] = useState<ProjectNavigationFailures>({})
  const [navigating, setNavigating] = useState(false)
  const forkPending = usePiStore((state) => state.forkPending)
  const editPhase = useSessionEdit((state) => state.phase)
  const skillAttachmentsBlocked = useTextAttachments((state) => Boolean(state.files.length || state.staging || state.sending || state.submission))
  const navigationDisabledReason = forkPending
    ? '正在分叉会话'
    : editPhase !== 'closed'
      ? '请先完成或取消编辑'
      : null
  const [layout, dispatchLayout] = useReducer(workspaceLayoutReducer, INITIAL_WORKSPACE_LAYOUT)
  const settingsOpenRef = useRef(layout.settingsOpen)
  const settingsOpenerRef = useRef<HTMLElement | null>(null)
  settingsOpenRef.current = layout.settingsOpen
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
      if (event.event === 'disconnected') disconnect(event.data.message)
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
  }, [applyPatch, disconnect, setClientError, setSnapshot])

  useEffect(
    () =>
      startWorkbenchEventCoordinator({
        subscribe: window.pi.onWorkbenchEvent,
        getState: () => window.pi.workbench({ type: 'state:get' }),
        onSnapshot: acceptWorkbenchSnapshot,
        onReveal: (viewId) => {
          // A background extension must not dismiss settings or replace the user's panel.
          if (settingsOpenRef.current) return
          dispatchWorkbenchSelection({ type: 'reveal', viewId })
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
    async (command: HostCommand): Promise<boolean> => {
      if (usePiStore.getState().disconnected) {
        setClientError('Pi 引擎未连接，请先重新连接引擎。')
        return false
      }
      try {
        const result = await window.pi.send(command)
        if (result.kind === 'snapshot') setSnapshot(result.snapshot)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setClientError(
          message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
        )
        return false
      }
    },
    [setClientError, setSnapshot]
  )

  const reconnect = async (): Promise<void> => {
    if (reconnecting) return
    setReconnecting(true)
    try {
      recover(await window.pi.reconnect())
    } catch {
      disconnect('重新连接失败。草稿和当前画布已保留，请稍后重试。')
    } finally {
      setReconnecting(false)
    }
  }

  const chooseProject = useCallback(async (): Promise<void> => {
    if (
      navigationLock.current ||
      usePiStore.getState().forkPending ||
      useSessionEdit.getState().phase !== 'closed' ||
      projectNavigationReason(usePiStore.getState().snapshot)
    )
      return
    if (usePiStore.getState().disconnected) {
      setClientError('Pi 引擎未连接，请先重新连接引擎。')
      return
    }
    navigationLock.current = true
    setNavigating(true)
    try {
      const state = await window.pi.selectProject()
      if (state) setSnapshot(state)
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error))
    } finally {
      navigationLock.current = false
      setNavigating(false)
    }
  }, [setClientError, setSnapshot])

  const navigateProject = useCallback(
    async (cwd: string, sessionPath?: string): Promise<void> => {
      const current = usePiStore.getState().snapshot
      if (
        navigationLock.current ||
        usePiStore.getState().forkPending ||
        useSessionEdit.getState().phase !== 'closed' ||
        projectNavigationReason(current)
      )
        return
      setNavigationFailures((previous) => {
        const next = { ...previous }
        delete next[cwd]
        return next
      })
      if (cwd === current.project?.path && sessionPath && sessionPath === current.activeSessionPath)
        return
      navigationLock.current = true
      const attempt = ++navigationAttempt.current
      setNavigating(true)
      try {
        const result = await window.pi.send({
          type: 'project:navigate',
          cwd,
          ...(sessionPath ? { sessionPath } : {}),
          sessionId: current.sessionId,
          generation: current.generation
        })
        if (attempt === navigationAttempt.current) setSnapshot(result.snapshot)
      } catch (error) {
        // A failed transition may already have published a new identity; read the actual state.
        try {
          setSnapshot(await window.pi.getState())
        } catch {
          /* Keep last observed snapshot. */
        }
        const message =
          error instanceof Error
            ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
            : '项目切换未完成，请重试'
        if (attempt === navigationAttempt.current)
          setNavigationFailures((previous) => ({
            ...previous,
            [cwd]: { message, ...(sessionPath ? { sessionPath } : {}) }
          }))
      } finally {
        navigationLock.current = false
        setNavigating(false)
      }
    },
    [setSnapshot]
  )

  const sendWorkbench = useCallback(
    async (command: WorkbenchCommand): Promise<void> => {
      const result = await window.pi.workbench(command)
      dispatchWorkbenchStatus({ type: 'clear' })
      acceptWorkbenchSnapshot(result.state)
    },
    [acceptWorkbenchSnapshot]
  )

  const openSettings = useCallback((): void => {
    if (!settingsOpenRef.current) {
      settingsOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
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
        onNewSession={() => {
          if (snapshot.project) void navigateProject(snapshot.project.path)
        }}
        onNavigate={(cwd, path) => void navigateProject(cwd, path)}
        navigationFailures={navigationFailures}
        pending={navigating}
        disabledReason={navigationDisabledReason}
        onOpenSettings={openSettings}
      />

      <Conversation
        snapshot={snapshot}
        approvals={snapshot.approvals}
        loading={loading}
        error={clientError ?? snapshot.error}
        onChooseProject={() => void chooseProject()}
        onSend={(text, identity) => send({ type: 'prompt:send', text, ...identity })}
        onOpenSession={(path) => void send({ type: 'session:open', path })}
        onReconnect={() => void reconnect()}
        reconnecting={reconnecting}
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
        collapsed={!workbenchOpen}
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
      />
      <SettingsDialog
        skillsContent={<SkillsSettings snapshot={snapshot}
          insertDisabled={Boolean(forkPending) || editPhase !== 'closed' || skillAttachmentsBlocked || !snapshot.ready || snapshot.modelAvailability !== 'available' || snapshot.composeBlockReason !== null}
          onInsert={(request) => {
            settingsOpenerRef.current = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="给 Pi 的任务"]')
            useSkillInsertion.getState().request(request)
            closeSettings()
          }}
        />}
        mcpContent={<McpSettings snapshot={snapshot} />}
        renderAccountQuota={(account) => (
          <AccountQuota
            account={account}
            authGeneration={snapshot.authGeneration ?? 0}
            loginActive={['starting', 'browser', 'device_code', 'waiting'].includes(snapshot.login.phase)}
          />
        )}
        open={layout.settingsOpen}
        returnFocusRef={settingsOpenerRef}
        onOpenChange={(open) => (open ? openSettings() : closeSettings())}
        agentSnapshot={snapshot}
        workbenchSnapshot={workbenchStatus.snapshot}
        onWorkbenchCommand={sendWorkbench}
        onLogin={login}
        onAddAlias={(slug) => void send({ type: 'account:alias:add', slug })}
        onLoginPrompt={(promptId, value) => {
          void send({ type: 'account:login:respond', promptId, value })
        }}
      />
    </div>
  )
}
