import { useEffect, useLayoutEffect, useState } from 'react'
import { CircleAlert, MonitorCog } from 'lucide-react'
import WorkbenchTabs, { WorkbenchLauncher } from './WorkbenchTabs'
import { openInBrowser, useBrowserState } from '../store/browser-state'
import { isBrowserContribution, workbenchTabId } from '../store/workbench-tab-items'
import type {
  AgentSnapshot,
  WorkbenchCommand,
  WorkbenchContribution,
  WorkbenchSnapshot
} from '../../../shared/contracts'
import BrowserPane from './BrowserPane'
import FilesPane from './FilesPane'
import GitReviewPane from './GitReviewPane'
import SandboxedPluginPane from './SandboxedPluginPane'
import TerminalPane from './TerminalPane'
import { useWorkspaceResizing } from './WorkspacePanels'
import { t } from '../../../shared/i18n'

type WorkbenchProps = {
  collapsed: boolean
  selectedViewId: string | null
  openedViewIds: readonly string[]
  onCloseView: (viewId: string) => void
  settingsOpen: boolean
  agentSnapshot: AgentSnapshot
  workbenchSnapshot: WorkbenchSnapshot
  workbenchError: string | null
  onSelectView: (viewId: string) => void
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onWorkbenchError: (message: string) => void
}

function EmptyWorkbench({ hasContributions }: { hasContributions: boolean }): React.JSX.Element {
  return (
    <div className="workbench-body">
      <MonitorCog size={23} />
      <p className="workbench-empty-title">
        {hasContributions ? t('选择一个工作台面板') : t('暂无可用面板')}
      </p>
      <p className="workbench-empty-copy">
        {hasContributions
          ? t('从活动栏选择一个面板；一次只会打开一个工作台视图。')
          : t('选择工作区或在设置中重新加载插件，即可查看可用的右侧面板。')}
      </p>
    </div>
  )
}

function ContributionSurface({
  contribution,
  projectReady,
  gitReady,
  projectPath,
  visible,
  onCommand,
  onError
}: {
  contribution: WorkbenchContribution | undefined
  projectReady: boolean
  gitReady: boolean
  projectPath: string | null
  visible: boolean
  onCommand: (command: WorkbenchCommand) => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  if (!contribution) return <EmptyWorkbench hasContributions={false} />
  if (contribution.surface.kind === 'first-party') {
    if (contribution.surface.adapter === 'files')
      return <FilesPane key={projectPath ?? 'no-project'} projectPath={projectPath} />
    if (contribution.surface.adapter === 'review')
      return (
        <GitReviewPane
          key={`${projectPath ?? 'no-project'}:${gitReady}`}
          projectPath={projectPath}
          ready={gitReady}
        />
      )
    // Terminal is owned by the persistent stage below, outside conditional surfaces.
    return <></>
  }
  if (contribution.surface.kind === 'native-view') {
    return (
      <BrowserPane
        viewId={contribution.viewId}
        projectReady={projectReady}
        visible={visible}
        onWorkbenchCommand={onCommand}
        onWorkbenchError={onError}
      />
    )
  }
  if (contribution.surface.kind === 'sandboxed-web') {
    return (
      <SandboxedPluginPane
        viewId={contribution.viewId}
        visible={visible}
        onWorkbenchCommand={onCommand}
        onWorkbenchError={onError}
      />
    )
  }
  return <EmptyWorkbench hasContributions />
}

export default function Workbench({
  collapsed,
  selectedViewId,
  openedViewIds,
  onCloseView,
  settingsOpen,
  agentSnapshot,
  workbenchSnapshot,
  workbenchError,
  onSelectView,
  onWorkbenchCommand,
  onWorkbenchError
}: WorkbenchProps): React.JSX.Element {
  const [domOverlayOpen, setDomOverlayOpen] = useState(false)
  useEffect(() => {
    const selector =
      '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [data-native-suspend="true"]'
    const touchesOverlay = (node: Node): boolean =>
      node instanceof Element && (node.matches(selector) || Boolean(node.querySelector(selector)))
    const update = (): void => {
      const next = Boolean(document.querySelector(selector))
      setDomOverlayOpen((current) => (current === next ? current : next))
    }
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.type === 'attributes') return true
        return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(
          touchesOverlay
        )
      })
      if (relevant) update()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'data-native-suspend']
    })
    update()
    return () => observer.disconnect()
  }, [])
  const resizing = useWorkspaceResizing()
  const [menuOpen, setMenuOpen] = useState(false)
  // A registry prune can unmount the dropdown without firing onOpenChange.
  // Its native-view suspension must never outlive the tab/menu that owns it.
  useLayoutEffect(() => {
    setMenuOpen(false)
  }, [collapsed, selectedViewId, openedViewIds.length])
  const selectedContribution = workbenchSnapshot.contributions.find(
    ({ viewId }) => viewId === selectedViewId
  )
  const selectedBrowser = Boolean(
    selectedContribution && isBrowserContribution(selectedContribution)
  )
  const browserPages = useBrowserState((store) => store.state.pages.length > 0)
  const activeBrowserPage = useBrowserState((store) => store.state.activePageId)
  return (
    <aside
      className={`workbench${collapsed ? ' is-collapsed' : ''}`}
      aria-label={collapsed ? t('折叠的工作台') : t('工作台')}
    >
      <div className="workbench-stage" hidden={collapsed}>
        <WorkbenchTabs
          contributions={workbenchSnapshot.contributions}
          openedViewIds={openedViewIds}
          selectedViewId={selectedViewId}
          onSelect={onSelectView}
          onClose={onCloseView}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
        />

        {workbenchError ? (
          <div className="workbench-error" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{workbenchError}</span>
          </div>
        ) : null}

        <div
          className="workbench-stage-body"
          id="workbench-active-panel"
          role={selectedViewId ? 'tabpanel' : undefined}
          aria-labelledby={
            selectedViewId
              ? workbenchTabId(
                  selectedViewId,
                  selectedBrowser && browserPages ? activeBrowserPage : null
                )
              : undefined
          }
        >
          <TerminalPane
            projectPath={agentSnapshot.project?.path ?? null}
            visible={
              !collapsed &&
              !settingsOpen &&
              selectedContribution?.surface.kind === 'first-party' &&
              selectedContribution.surface.adapter === 'terminal'
            }
          />
          {selectedContribution?.surface.kind === 'first-party' &&
          selectedContribution.surface.adapter === 'terminal' ? null : selectedContribution ? (
            <ContributionSurface
              contribution={selectedContribution}
              projectReady={Boolean(agentSnapshot.project)}
              gitReady={agentSnapshot.ready}
              projectPath={agentSnapshot.project?.path ?? null}
              visible={!collapsed && !settingsOpen && !resizing && !menuOpen && !domOverlayOpen}
              onCommand={onWorkbenchCommand}
              onError={onWorkbenchError}
            />
          ) : (
            <WorkbenchLauncher
              contributions={workbenchSnapshot.contributions}
              onSelect={onSelectView}
              onOpenSite={(url) => {
                const browser = workbenchSnapshot.contributions.find(isBrowserContribution)
                if (!browser) return
                // Open the page first, so showing the browser does not add a blank one.
                void openInBrowser(url).then(() => onSelectView(browser.viewId))
              }}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
