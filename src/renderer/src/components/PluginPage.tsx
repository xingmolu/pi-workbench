import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { WorkbenchCommand, WorkbenchContribution } from '../../../shared/contracts'
import SandboxedPluginPane from './SandboxedPluginPane'
import { ContributionIcon } from './WorkbenchTabs'
import { t } from '../../../shared/i18n'

/** A plugin page opened from the activity rail, filling the window right of the rail. */
export default function PluginPage({
  contribution,
  windowControls,
  visible,
  onClose,
  onWorkbenchCommand,
  onWorkbenchError
}: {
  contribution: WorkbenchContribution
  /** Back, forward and the sidebar switch, at the start of the header. */
  windowControls?: ReactNode
  /** False while a dialog or overlay sits above, so the native page does not cover it. */
  visible: boolean
  onClose: () => void
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onWorkbenchError: (message: string) => void
}): React.JSX.Element {
  return (
    <main className="plugin-page" aria-label={contribution.title}>
      <header className="plugin-page-head">
        {windowControls}
        <ContributionIcon contribution={contribution} />
        <h1>{contribution.title}</h1>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('关闭 {title}', { title: contribution.title })}
          title={t('返回对话')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <SandboxedPluginPane
        key={contribution.viewId}
        viewId={contribution.viewId}
        visible={visible}
        onWorkbenchCommand={onWorkbenchCommand}
        onWorkbenchError={onWorkbenchError}
      />
    </main>
  )
}
