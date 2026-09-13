import {
  Blocks,
  ChevronRight,
  CircleAlert,
  Files,
  FlaskConical,
  GitPullRequest,
  Globe2,
  MonitorCog,
  Puzzle,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react'
import type {
  AgentSnapshot,
  WorkbenchCommand,
  WorkbenchContribution,
  WorkbenchIcon,
  WorkbenchSnapshot
} from '../../../shared/contracts'
import BrowserPane from './BrowserPane'
import FilesPane from './FilesPane'
import GitReviewPane from './GitReviewPane'
import SandboxedPluginPane from './SandboxedPluginPane'
import TerminalPane from './TerminalPane'

const WORKBENCH_ICONS: Record<WorkbenchIcon, LucideIcon> = {
  files: Files,
  'git-review': GitPullRequest,
  terminal: TerminalSquare,
  browser: Globe2,
  plugin: Puzzle,
  flask: FlaskConical
}

type WorkbenchProps = {
  collapsed: boolean
  selectedViewId: string | null
  settingsOpen: boolean
  agentSnapshot: AgentSnapshot
  workbenchSnapshot: WorkbenchSnapshot
  workbenchError: string | null
  onSelectView: (viewId: string) => void
  onToggle: () => void
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onWorkbenchError: (message: string) => void
}

function contributionIcon(icon: WorkbenchIcon): LucideIcon {
  return WORKBENCH_ICONS[icon] ?? Blocks
}

function EmptyWorkbench({ hasContributions }: { hasContributions: boolean }): React.JSX.Element {
  return (
    <div className="workbench-body">
      <MonitorCog size={23} />
      <p className="workbench-empty-title">
        {hasContributions ? '选择一个工作台面板' : '暂无可用面板'}
      </p>
      <p className="workbench-empty-copy">
        {hasContributions
          ? '从活动栏选择一个面板；一次只会打开一个工作台视图。'
          : '选择工作区或在设置中重新加载插件，即可查看可用的右侧面板。'}
      </p>
    </div>
  )
}

function ContributionSurface({
  contribution,
  projectReady,
  gitReady,
  projectPath,
  onCommand,
  onError
}: {
  contribution: WorkbenchContribution | undefined
  projectReady: boolean
  gitReady: boolean
  projectPath: string | null
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
        onWorkbenchCommand={onCommand}
        onWorkbenchError={onError}
      />
    )
  }
  if (contribution.surface.kind === 'sandboxed-web') {
    return (
      <SandboxedPluginPane
        viewId={contribution.viewId}
        visible
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
  settingsOpen,
  agentSnapshot,
  workbenchSnapshot,
  workbenchError,
  onSelectView,
  onToggle,
  onWorkbenchCommand,
  onWorkbenchError
}: WorkbenchProps): React.JSX.Element {
  const selectedContribution = workbenchSnapshot.contributions.find(
    ({ viewId }) => viewId === selectedViewId
  )
  const selectedPlugin = selectedContribution
    ? workbenchSnapshot.plugins.find(({ pluginId }) => pluginId === selectedContribution.pluginId)
    : undefined
  const SelectedIcon = selectedContribution
    ? contributionIcon(selectedContribution.icon)
    : MonitorCog

  return (
    <aside
      className={`workbench${collapsed ? ' is-collapsed' : ''}`}
      aria-label={collapsed ? '折叠的工作台' : '工作台'}
    >
      <nav className="workbench-rail" aria-label="工作台视图">
        <div className="workbench-rail-spacer" aria-hidden="true" />
        <div className="workbench-rail-scroll">
          {workbenchSnapshot.contributions.map((contribution) => {
            const Icon = contributionIcon(contribution.icon)
            const active = contribution.viewId === selectedViewId
            return (
              <button
                key={contribution.viewId}
                type="button"
                className={`workbench-rail-button${active ? ' is-active' : ''}`}
                title={contribution.title}
                aria-label={contribution.title}
                aria-pressed={active}
                onClick={() => onSelectView(contribution.viewId)}
              >
                <Icon size={17} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      </nav>

      <div className="workbench-stage" hidden={collapsed}>
        <header className="workbench-stage-head">
          <div className="workbench-stage-title">
            <SelectedIcon size={15} />
            <span title={collapsed ? undefined : selectedContribution?.title}>
              {selectedContribution?.title ?? '工作台'}
            </span>
            {selectedContribution ? (
              <small>{selectedPlugin?.builtin ? '内置' : '插件'}</small>
            ) : null}
          </div>
          <button
            className="icon-btn workbench-fold"
            type="button"
            onClick={onToggle}
            title="折叠工作台"
            aria-label="折叠工作台"
          >
            <ChevronRight size={17} />
          </button>
        </header>

        {workbenchError ? (
          <div className="workbench-error" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{workbenchError}</span>
          </div>
        ) : null}

        <div className="workbench-stage-body">
          <TerminalPane
            projectPath={agentSnapshot.project?.path ?? null}
            visible={
              !collapsed &&
              !settingsOpen &&
              selectedContribution?.surface.kind === 'first-party' &&
              selectedContribution.surface.adapter === 'terminal'
            }
          />
          {collapsed ||
          (settingsOpen &&
            (selectedContribution?.surface.kind === 'native-view' ||
              selectedContribution?.surface.kind === 'sandboxed-web')) ? null : selectedContribution
              ?.surface.kind === 'first-party' &&
            selectedContribution.surface.adapter === 'terminal' ? null : selectedContribution ? (
            <ContributionSurface
              contribution={selectedContribution}
              projectReady={Boolean(agentSnapshot.project)}
              gitReady={agentSnapshot.ready}
              projectPath={agentSnapshot.project?.path ?? null}
              onCommand={onWorkbenchCommand}
              onError={onWorkbenchError}
            />
          ) : (
            <EmptyWorkbench hasContributions={workbenchSnapshot.contributions.length > 0} />
          )}
        </div>
      </div>
    </aside>
  )
}
