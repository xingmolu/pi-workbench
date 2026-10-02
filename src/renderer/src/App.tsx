import SubagentDirectory from './components/SubagentDirectory'
import { Bot } from 'lucide-react'
import RuntimePicker from './components/RuntimePicker'
import { useRuntimeCatalog } from './store/runtime-catalog'
import './assets/runtime-workbench.css'
import SubagentInspector from './components/SubagentInspector'
import type { SubagentSummary } from '../../shared/subagent'
import type { DesktopCommandOrigin } from '../../shared/session-runtime'
import { useNavigationLibrary } from './store/navigation-library'
import NavigationFeedback from './components/navigation/NavigationFeedback'
import PluginApprovalDialog, { type PluginApproval } from './components/PluginApprovalDialog'
import CredentialGrantDialog from './components/CredentialGrantDialog'
import './assets/navigation.css'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { applyDocumentTheme, useResolvedTheme } from './store/theme'
import { applyThemeOverrides, usePluginThemes } from './store/plugin-themes'
import { PanelRight } from 'lucide-react'
import { useDesktopSettings } from './store/desktop-settings'
import './assets/desktop-settings.css'
import type {
  ApprovalScope,
  HostCommand,
  LoginMethod,
  WorkbenchCommand,
  WorkbenchSnapshot
} from '../../shared/contracts'
import Sidebar from './components/Sidebar'
import { shortcutLabel } from './components/shortcut-label'
import Conversation from './components/Conversation'
import Workbench from './components/Workbench'
import WorkspacePanels from './components/WorkspacePanels'
import SettingsDialog from './components/SettingsDialog'
import GlobalCommandPalette from './components/GlobalCommandPalette'
import { useOverlayState } from './store/overlay-state'
import McpSettings from './components/McpSettings'
import SkillsSettings from './components/SkillsSettings'
import { useSkillInsertion } from './store/skill-draft'
import { useTextAttachments } from './store/text-attachments'
import { modelSelectionCommand } from './store/composer-model-selection'
import { projectNavigationReason } from '../../shared/project-catalog'
import type { ProjectCatalog, ProjectNavigationFailures } from '../../shared/project-catalog'
import { useSessionEdit } from './store/session-edit'
import { commandOrigin, usePiStore } from './store/pi-store'
import { sameSelectedScope } from '../../shared/session-runtime'
import { startWorkbenchEventCoordinator } from './store/workbench-event-coordinator'
import { useNavigationFeedback } from './store/navigation-feedback'
import type { PluginCommandSummary } from '../../shared/workbench-contracts'
import { INITIAL_WORKBENCH_SELECTION, workbenchSelectionReducer } from './store/workbench-selection'
import { INITIAL_WORKBENCH_STATUS, workbenchStatusReducer } from './store/workbench-status'
import { INITIAL_WORKSPACE_LAYOUT, workspaceLayoutReducer } from './store/workspace-layout'

export default function App(): React.JSX.Element {
  useEffect(() => {
    void useRuntimeCatalog
      .getState()
      .load()
      .catch((error) => usePiStore.getState().setClientError(String(error)))
  }, [])
  const theme = useResolvedTheme()
  useLayoutEffect(() => applyDocumentTheme(theme), [theme])
  const accent = useDesktopSettings((state) => state.settings.accent)
  const pluginThemeId = useDesktopSettings((state) => state.settings.pluginTheme)
  const pluginThemes = usePluginThemes((state) => state.themes)
  useLayoutEffect(
    () =>
      applyThemeOverrides(
        accent,
        pluginThemes.find((candidate) => candidate.id === pluginThemeId) ?? null
      ),
    [accent, pluginThemeId, pluginThemes]
  )
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
  const [recentProject, setRecentProject] = useState<{
    path: string
    name: string
    sessionPath?: string
    sessionTitle?: string
  } | null>(null)
  const acceptCatalog = useCallback((catalog: ProjectCatalog | null): void => {
    const project = catalog?.projects.find((item) => !item.error)
    if (!project) {
      setRecentProject(null)
      return
    }
    const latestSession = [...project.sessions]
      .filter((session) => Boolean(session.path))
      .sort((left, right) => right.modified.localeCompare(left.modified))[0]
    setRecentProject({
      path: project.path,
      name: project.name,
      ...(latestSession
        ? { sessionPath: latestSession.path, sessionTitle: latestSession.title }
        : {})
    })
  }, [])
  const forkPending = usePiStore((state) => state.forkPending)
  const runtimeCount = useRuntimeCatalog((state) => state.runtimes.length)
  const editPhase = useSessionEdit((state) => state.phase)
  const skillAttachmentsBlocked = useTextAttachments((state) =>
    Boolean(state.files.length || state.staging || state.sending || state.submission)
  )
  const navigationDisabledReason = forkPending
    ? '正在分叉会话'
    : editPhase !== 'closed'
      ? '请先完成或取消编辑'
      : null
  const [layout, dispatchLayout] = useReducer(workspaceLayoutReducer, INITIAL_WORKSPACE_LAYOUT)
  const settingsOpenRef = useRef(layout.settingsOpen)
  const settingsOpenerRef = useRef<HTMLElement | null>(null)
  const paletteOpenerRef = useRef<HTMLElement | null>(null)
  const nativePaletteTokenRef = useRef<string | undefined>(undefined)
  const activeOverlay = useOverlayState((state) => state.active)
  const openPalette = useCallback((nativeToken?: string): void => {
    if (
      document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]') ||
      !useOverlayState.getState().open('command')
    ) {
      if (nativeToken)
        void window.pi
          .nativePaletteFocus({ type: 'finish', token: nativeToken, restore: false })
          .catch(() => {})
      return
    }
    if (!nativeToken) void window.pi.nativePaletteFocus({ type: 'invalidate' }).catch(() => {})
    nativePaletteTokenRef.current = nativeToken
    paletteOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [])
  const closePalette = useCallback((): void => {
    useOverlayState.getState().close('command')
  }, [])
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
  const availableWorkbenchViews = useRef<readonly string[]>([])
  const pluginNames = useRef(new Map<string, string>())
  const [pluginCommands, setPluginCommands] = useState<PluginCommandSummary[]>([])
  const [pluginApprovals, setPluginApprovals] = useState<PluginApproval[]>([])
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [subagentDirectoryOpen, setSubagentDirectoryOpen] = useState(false)
  const directoryPreviousWorkbench = useRef(false)
  const closeDirectory = useCallback((): void => {
    setSubagentDirectoryOpen(false)
    setWorkbenchOpen(directoryPreviousWorkbench.current)
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.subagent-directory-toggle')?.focus()
    )
  }, [])
  const [subagentPreview, setSubagentPreview] = useState<{
    child: SubagentSummary
    owner: DesktopCommandOrigin
  } | null>(null)
  const subagentOpener = useRef<HTMLElement | null>(null)
  const subagentOpenerChild = useRef<string | null>(null)
  const subagentRestoreWorkbench = useRef(false)
  const selectWorkbenchView = useCallback((viewId: string): void => {
    setSubagentPreview(null)
    setSubagentDirectoryOpen(false)
    dispatchWorkbenchSelection({ type: 'select', viewId })
    setWorkbenchOpen(true)
  }, [])
  const closeSubagentPreview = useCallback(() => {
    setWorkbenchOpen(subagentRestoreWorkbench.current)
    setSubagentPreview(null)
    requestAnimationFrame(() => {
      const directoryRow = Array.from(
        document.querySelectorAll<HTMLElement>('.subagent-directory-row')
      ).find((row) => row.dataset.subagentId === subagentOpenerChild.current)
      const opener = subagentOpener.current?.isConnected ? subagentOpener.current : null
      ;(
        directoryRow ??
        opener ??
        document.querySelector<HTMLElement>('[aria-label="关闭子 Agent 列表"]')
      )?.focus({ preventScroll: true })
    })
  }, [])
  useEffect(() => {
    if (
      subagentPreview &&
      (snapshot.sessionId !== subagentPreview.owner.sessionId ||
        snapshot.generation !== subagentPreview.owner.generation ||
        !sameSelectedScope(snapshot.desktopScope ?? null, subagentPreview.owner.scope))
    )
      closeSubagentPreview()
  }, [
    snapshot.sessionId,
    snapshot.generation,
    snapshot.desktopScope,
    subagentPreview,
    closeSubagentPreview
  ])
  useEffect(() => {
    void useNavigationLibrary.getState().hydrate()
  }, [])
  useEffect(() => {
    if (!snapshot.project) setWorkbenchOpen(false)
  }, [snapshot.project?.path])
  const desktopSettings = useDesktopSettings((state) => state.settings)
  useEffect(() => {
    if (!useDesktopSettings.getState().hasLoaded) void useDesktopSettings.getState().hydrate()
  }, [])
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--message-font-size',
      `${desktopSettings.messageFontSize}px`
    )
    document.documentElement.style.setProperty(
      '--code-font-size',
      `${desktopSettings.codeFontSize}px`
    )
    document.documentElement.dataset.reducedMotion = String(desktopSettings.reducedMotion)
  }, [desktopSettings])

  const acceptWorkbenchSnapshot = useCallback((state: WorkbenchSnapshot): void => {
    if (state.revision <= workbenchRevision.current) return
    workbenchRevision.current = state.revision
    availableWorkbenchViews.current = state.contributions.map(({ viewId }) => viewId)
    pluginNames.current = new Map(state.plugins.map((plugin) => [plugin.pluginId, plugin.name]))
    setPluginCommands(state.commands ?? [])
    usePluginThemes.getState().setThemes(state.themes ?? [])
    dispatchWorkbenchStatus({ type: 'snapshot', snapshot: state })
    dispatchWorkbenchSelection({ type: 'snapshot', contributions: state.contributions })
  }, [])

  const reportWorkbenchError = useCallback((message: string): void => {
    dispatchWorkbenchStatus({ type: 'error', message })
  }, [])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.pi.onEvent((event) => {
      if (event.event === 'command-palette') {
        if (
          !useOverlayState.getState().active &&
          !document.querySelector('[role="dialog"], [role="alertdialog"]')
        )
          openPalette(event.data.token)
        else
          void window.pi
            .nativePaletteFocus({ type: 'finish', token: event.data.token, restore: false })
            .catch(() => {})
      }
      if (event.event === 'disconnected') disconnect(event.data.message)
      if (event.event === 'sessions') usePiStore.getState().setLiveSessions(event.data)
      if (event.event === 'navigation-library') useNavigationLibrary.getState().accept(event.data)
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
  }, [applyPatch, disconnect, setClientError, setSnapshot, openPalette])

  useEffect(
    () =>
      startWorkbenchEventCoordinator({
        subscribe: window.pi.onWorkbenchEvent,
        getState: () => window.pi.workbench({ type: 'state:get' }),
        onSnapshot: acceptWorkbenchSnapshot,
        onReveal: (viewId) => {
          // Background reveals must not replace the user's panel while settings are open.
          if (settingsOpenRef.current || useOverlayState.getState().active) return
          if (!availableWorkbenchViews.current.includes(viewId)) return
          dispatchWorkbenchSelection({ type: 'reveal', viewId })
          setWorkbenchOpen(true)
        },
        onError: reportWorkbenchError,
        onApproval: (event) =>
          setPluginApprovals((current) =>
            event.type === 'plugin-approval'
              ? [...current.filter(({ id }) => id !== event.id), event]
              : current.filter(({ id }) => id !== event.id)
          ),
        onToast: (pluginId, message) =>
          useNavigationFeedback.getState().notify({
            message: `${pluginNames.current.get(pluginId) ?? '插件'}：${message}`
          })
      }),
    [acceptWorkbenchSnapshot, reportWorkbenchError]
  )

  // A file path clicked in the terminal opens the Files panel on that file.
  const fileOpen = useOverlayState((state) => state.fileOpen)
  useEffect(() => {
    if (!fileOpen) return
    const files = workbenchStatus.snapshot.contributions.find(
      (item) => item.surface.kind === 'first-party' && item.surface.adapter === 'files'
    )
    if (!files) return
    selectWorkbenchView(files.viewId)
    // Only a new request switches panels; later snapshots must not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileOpen?.revision])

  const shortcuts = useRef({ newSession: () => {}, openTerminal: () => {} })
  useEffect(() => {
    let composing = false
    const startComposition = (): void => {
      composing = true
    }
    const endComposition = (): void => {
      composing = false
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || composing) return
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (useOverlayState.getState().active === 'command') {
          event.preventDefault()
          closePalette()
          return
        }
        if (
          useOverlayState.getState().active ||
          document.querySelector('[role="dialog"], [role="alertdialog"]')
        )
          return
        event.preventDefault()
        openPalette()
        return
      }
      if (event.metaKey && event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        dispatchLayout({ type: 'sidebar:toggle' })
        return
      }
      // ⌘ on macOS, Ctrl elsewhere; a focused terminal keeps its own Ctrl keys.
      const mac = navigator.platform.includes('Mac')
      const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!mod || event.altKey || event.shiftKey) return
      if (!mac && (event.target as Element | null)?.closest?.('.xterm, .terminal-pane')) return
      if (
        useOverlayState.getState().active ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        shortcuts.current.newSession()
      } else if (key === '\\') {
        event.preventDefault()
        if (subagentPreview) closeSubagentPreview()
        else if (subagentDirectoryOpen) closeDirectory()
        else setWorkbenchOpen((open) => !open)
      } else if (key === 'j') {
        event.preventDefault()
        shortcuts.current.openTerminal()
      }
    }
    // Holding the modifier for a moment reveals the shortcuts on the controls that have one.
    const modifier = navigator.platform.includes('Mac') ? 'Meta' : 'Control'
    let hintTimer: ReturnType<typeof setTimeout> | null = null
    const hideHints = (): void => {
      if (hintTimer) clearTimeout(hintTimer)
      hintTimer = null
      document.documentElement.classList.remove('show-shortcuts')
    }
    const onHintKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== modifier) {
        hideHints()
        return
      }
      if (!event.repeat && !hintTimer)
        hintTimer = setTimeout(() => document.documentElement.classList.add('show-shortcuts'), 450)
    }
    const onHintKeyUp = (event: KeyboardEvent): void => {
      if (event.key === modifier) hideHints()
    }
    window.addEventListener('keydown', onHintKeyDown)
    window.addEventListener('keyup', onHintKeyUp)
    window.addEventListener('blur', hideHints)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('compositionstart', startComposition)
    window.addEventListener('compositionend', endComposition)
    return () => {
      hideHints()
      window.removeEventListener('keydown', onHintKeyDown)
      window.removeEventListener('keyup', onHintKeyUp)
      window.removeEventListener('blur', hideHints)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('compositionstart', startComposition)
      window.removeEventListener('compositionend', endComposition)
    }
  }, [
    openPalette,
    closePalette,
    subagentPreview,
    subagentDirectoryOpen,
    closeSubagentPreview,
    closeDirectory
  ])

  const send = useCallback(
    async (command: HostCommand): Promise<boolean> => {
      const origin = commandOrigin(snapshot)
      if (usePiStore.getState().disconnected) {
        setClientError('Pi 引擎未连接，请先重新连接引擎。')
        return false
      }
      try {
        const result = await window.pi.send(command, origin)
        if (result.kind === 'snapshot') setSnapshot(result.snapshot)
        return true
      } catch (error) {
        if (
          !sameSelectedScope(
            origin?.scope ?? null,
            usePiStore.getState().snapshot.desktopScope ?? null
          )
        )
          return false
        const message = error instanceof Error ? error.message : String(error)
        setClientError(
          message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
        )
        return false
      }
    },
    [setClientError, setSnapshot, snapshot]
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
      const state = await window.pi.selectProject(commandOrigin(usePiStore.getState().snapshot))
      if (state) setSnapshot(state)
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error))
    } finally {
      navigationLock.current = false
      setNavigating(false)
    }
  }, [setClientError, setSnapshot])

  const navigateProject = useCallback(
    async (
      cwd: string,
      sessionPath?: string,
      workerId?: string,
      runtimeId?: string
    ): Promise<void> => {
      const current = usePiStore.getState().snapshot
      if (
        navigationLock.current ||
        usePiStore.getState().forkPending ||
        useSessionEdit.getState().phase !== 'closed' ||
        projectNavigationReason(current, Boolean(workerId))
      )
        return
      setNavigationFailures((previous) => {
        const next = { ...previous }
        delete next[cwd]
        return next
      })
      if (
        current.ready &&
        cwd === current.project?.path &&
        sessionPath &&
        sessionPath === current.activeSessionPath
      )
        return
      navigationLock.current = true
      const attempt = ++navigationAttempt.current
      setNavigating(true)
      try {
        const next = workerId
          ? await window.pi.selectSession(workerId, commandOrigin(current))
          : (
              await window.pi.send(
                {
                  type: 'project:navigate',
                  cwd,
                  ...(runtimeId ? { runtimeId } : {}),
                  ...(sessionPath ? { sessionPath } : {}),
                  sessionId: current.sessionId,
                  generation: current.generation
                },
                commandOrigin(current)
              )
            ).snapshot
        if (attempt === navigationAttempt.current) setSnapshot(next)
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
        if (attempt === navigationAttempt.current && !usePiStore.getState().snapshot.project)
          setClientError(message)
      } finally {
        navigationLock.current = false
        setNavigating(false)
      }
    },
    [setClientError, setSnapshot]
  )

  shortcuts.current = {
    newSession: () => {
      if (snapshot.ready && snapshot.project) void navigateProject(snapshot.project.path)
    },
    openTerminal: () => {
      const terminal = workbenchStatus.snapshot.contributions.find(
        (item) => item.surface.kind === 'first-party' && item.surface.adapter === 'terminal'
      )
      if (!terminal || !snapshot.project) return
      selectWorkbenchView(terminal.viewId)
    }
  }

  const sendWorkbench = useCallback(
    async (command: WorkbenchCommand): Promise<void> => {
      const result = await window.pi.workbench(command)
      dispatchWorkbenchStatus({ type: 'clear' })
      acceptWorkbenchSnapshot(result.state)
    },
    [acceptWorkbenchSnapshot]
  )

  const openSettings = useCallback((): void => {
    if (!useOverlayState.getState().open('settings')) return
    void window.pi.nativePaletteFocus({ type: 'invalidate' }).catch(() => {})
    if (!settingsOpenRef.current) {
      settingsOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    dispatchLayout({ type: 'settings:open' })
  }, [])

  const closeSettings = useCallback((): void => {
    useOverlayState.getState().close('settings')
    dispatchLayout({ type: 'settings:close' })
  }, [])

  const login = useCallback(
    (providerId: string, method: LoginMethod): void => {
      void send({ type: 'account:login', providerId, method })
    },
    [send]
  )

  const respondToApproval = useCallback(
    (id: string, allow: boolean, scope?: ApprovalScope): Promise<boolean> => {
      return send({
        type: 'permission:respond',
        approvalId: id,
        allow,
        ...(scope === 'turn' ? { scope } : {})
      })
    },
    [send]
  )

  const inspectChild = (child: SubagentSummary): void => {
    const owner = commandOrigin(snapshot)
    if (!owner) return
    subagentOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    subagentOpenerChild.current = child.id
    if (!subagentPreview) subagentRestoreWorkbench.current = workbenchOpen
    setSubagentPreview({ child, owner })
    setWorkbenchOpen(true)
  }

  return (
    <div className={`shell${navigator.platform.includes('Mac') ? ' native-mac' : ''}`}>
      {snapshot.project && !subagentPreview && !subagentDirectoryOpen ? (
        <button
          type="button"
          className="icon-btn subagent-directory-toggle"
          aria-label="子 Agent 列表"
          title="子 Agent 列表"
          aria-expanded={subagentDirectoryOpen}
          onClick={() => {
            if (subagentDirectoryOpen) closeDirectory()
            else {
              directoryPreviousWorkbench.current = workbenchOpen
              setSubagentDirectoryOpen(true)
              setWorkbenchOpen(true)
            }
          }}
        >
          <Bot size={17} />
        </button>
      ) : null}
      {!subagentPreview && !subagentDirectoryOpen && (
        <button
          className="icon-btn workbench-toggle"
          aria-label={workbenchOpen ? '折叠工作台' : '展开工作台'}
          title={`${workbenchOpen ? '折叠工作台' : '展开工作台'}（${shortcutLabel('\\')}）`}
          data-shortcut={shortcutLabel('\\')}
          aria-expanded={workbenchOpen}
          onClick={() => setWorkbenchOpen((open) => !open)}
        >
          <PanelRight size={18} />
        </button>
      )}
      <Sidebar
        collapsed={layout.sidebarCollapsed}
        collapseLocked={layout.settingsOpen}
        snapshot={snapshot}
        runtimePicker={
          runtimeCount > 1 ? (
            <RuntimePicker
              variant="split"
              disabled={Boolean(navigationDisabledReason)}
              onNewSession={() => {
                if (snapshot.project) void navigateProject(snapshot.project.path)
              }}
            />
          ) : null
        }
        onToggle={() => dispatchLayout({ type: 'sidebar:toggle' })}
        onChooseProject={() => void chooseProject()}
        onNewSession={() => {
          if (snapshot.project) void navigateProject(snapshot.project.path)
        }}
        onNavigate={(cwd, path, workerId, runtimeId) =>
          void navigateProject(cwd, path, workerId, runtimeId)
        }
        onCatalog={acceptCatalog}
        navigationFailures={navigationFailures}
        pending={navigating}
        disabledReason={navigationDisabledReason}
        onOpenSettings={openSettings}
        onOpenSearch={() => openPalette()}
      />

      <WorkspacePanels
        collapsed={!workbenchOpen}
        conversation={
          <Conversation
            snapshot={snapshot}
            onInspectSubagent={inspectChild}
            approvals={snapshot.approvals}
            loading={loading}
            error={clientError ?? snapshot.error}
            onChooseProject={() => void chooseProject()}
            recentProject={recentProject}
            onContinueProject={(path, sessionPath) => void navigateProject(path, sessionPath)}
            projectNavigationPending={navigating}
            onSend={(text, identity) => send({ type: 'prompt:send', text, ...identity })}
            onOpenSession={(path) => void send({ type: 'session:open', path })}
            onReconnect={() => void reconnect()}
            reconnecting={reconnecting}
            onAbort={() => void send({ type: 'prompt:abort' })}
            onClearQueue={() => void send({ type: 'queue:clear' })}
            onPermissionChange={(permission) =>
              void send({ type: 'permission:set', mode: permission })
            }
            onChooseModel={(providerId, modelId) =>
              void send(modelSelectionCommand(providerId, modelId))
            }
            onLogin={() => {
              openSettings()
              login(snapshot.runtime?.id === 'claude' ? 'anthropic' : 'openai-codex', 'browser')
            }}
            onOpenSettings={openSettings}
            onApproval={respondToApproval}
          />
        }
        workbench={
          <div className="subagent-workbench-slot">
            <div
              className="subagent-existing-workbench"
              hidden={Boolean(subagentPreview) || subagentDirectoryOpen}
            >
              <Workbench
                collapsed={!workbenchOpen}
                selectedViewId={workbenchSelection.selectedViewId}
                openedViewIds={workbenchSelection.openedViewIds}
                onCloseView={(viewId) => dispatchWorkbenchSelection({ type: 'close', viewId })}
                settingsOpen={
                  layout.settingsOpen ||
                  activeOverlay !== null ||
                  Boolean(subagentPreview) ||
                  subagentDirectoryOpen
                }
                agentSnapshot={snapshot}
                workbenchSnapshot={workbenchStatus.snapshot}
                workbenchError={workbenchStatus.error}
                onSelectView={selectWorkbenchView}
                onWorkbenchCommand={sendWorkbench}
                onWorkbenchError={reportWorkbenchError}
              />
            </div>
            {subagentDirectoryOpen && !subagentPreview ? (
              <SubagentDirectory onInspect={inspectChild} onClose={closeDirectory} />
            ) : null}
            {subagentPreview ? (
              <SubagentInspector
                key={subagentPreview.child.id}
                child={subagentPreview.child}
                owner={subagentPreview.owner}
                parentNodes={snapshot.nodes}
                onClose={closeSubagentPreview}
                onOpen={(path) => {
                  closeSubagentPreview()
                  void send({ type: 'session:open', path })
                }}
              />
            ) : null}
          </div>
        }
      />
      {activeOverlay === 'command' && (
        <GlobalCommandPalette
          snapshot={snapshot}
          returnFocusRef={paletteOpenerRef}
          nativeFocusToken={nativePaletteTokenRef.current}
          disabledReason={navigationDisabledReason ?? (navigating ? '正在切换会话，请稍候' : null)}
          filesAvailable={Boolean(
            snapshot.ready &&
            snapshot.project &&
            workbenchStatus.snapshot.contributions.some(
              (item) => item.surface.kind === 'first-party' && item.surface.adapter === 'files'
            )
          )}
          onClose={closePalette}
          onNavigate={navigateProject}
          onChooseProject={chooseProject}
          pluginCommands={pluginCommands}
          onRunPluginCommand={(command) => {
            void window.pi
              .workbench({
                type: 'plugin:command:run',
                pluginId: command.pluginId,
                commandId: command.commandId
              })
              .then(({ state }) => acceptWorkbenchSnapshot(state))
              .catch((error: unknown) =>
                useNavigationFeedback.getState().notify({
                  message: `${command.pluginName}：${(error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}`,
                  error: true
                })
              )
          }}
          onSearchFiles={() => {
            const files = workbenchStatus.snapshot.contributions.find(
              (item) => item.surface.kind === 'first-party' && item.surface.adapter === 'files'
            )
            if (!files || !snapshot.project) return
            selectWorkbenchView(files.viewId)
            useOverlayState.getState().requestFileSearch(snapshot.project.path)
          }}
        />
      )}
      <NavigationFeedback />
      <CredentialGrantDialog />
      {pluginApprovals[0] ? (
        <PluginApprovalDialog
          key={pluginApprovals[0].id}
          approval={pluginApprovals[0]}
          onRespond={async (id, allow) => {
            await window.pi.workbench({ type: 'plugin:approval:respond', id, allow })
          }}
        />
      ) : null}
      <SettingsDialog
        skillsContent={
          snapshot.runtime && !snapshot.runtime.features.includes('skills') ? (
            <p className="inline-hint">{snapshot.runtime.label} 在运行时加载项目内的原生技能。</p>
          ) : (
            <SkillsSettings
              snapshot={snapshot}
              insertDisabled={
                Boolean(forkPending) ||
                editPhase !== 'closed' ||
                skillAttachmentsBlocked ||
                !snapshot.ready ||
                snapshot.modelAvailability !== 'available' ||
                snapshot.composeBlockReason !== null
              }
              onInsert={(request) => {
                settingsOpenerRef.current = document.querySelector<HTMLTextAreaElement>(
                  'textarea[aria-label="任务输入"]'
                )
                useSkillInsertion.getState().request(request)
                closeSettings()
              }}
            />
          )
        }
        mcpContent={<McpSettings snapshot={snapshot} />}
        open={layout.settingsOpen}
        returnFocusRef={settingsOpenerRef}
        onOpenChange={(open) => (open ? openSettings() : closeSettings())}
        agentSnapshot={snapshot}
        workbenchSnapshot={workbenchStatus.snapshot}
        onWorkbenchCommand={sendWorkbench}
      />
    </div>
  )
}
