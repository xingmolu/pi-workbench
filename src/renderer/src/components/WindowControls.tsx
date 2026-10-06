import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react'
import { shortcutLabel } from './shortcut-label'
import { t } from '../../../shared/i18n'

export type WindowControlsProps = {
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  sidebarOpen: boolean
  sidebarLocked: boolean
  onToggleSidebar: () => void
}

/** Back, forward and the sidebar switch, sitting in the title bar after the window buttons.
 * They render in whichever header meets the activity rail: the sidebar's, the conversation's
 * when the sidebar is folded, or a plugin page's. */
export default function WindowControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  sidebarOpen,
  sidebarLocked,
  onToggleSidebar
}: WindowControlsProps): React.JSX.Element {
  return (
    <div className="window-controls" role="toolbar" aria-label={t('窗口导航')}>
      <button
        type="button"
        className="window-control"
        aria-label={t('后退')}
        title={t('后退（{shortcut}）', { shortcut: shortcutLabel('[') })}
        disabled={!canGoBack}
        onClick={onBack}
      >
        <ArrowLeft size={16} />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={t('前进')}
        title={t('前进（{shortcut}）', { shortcut: shortcutLabel(']') })}
        disabled={!canGoForward}
        onClick={onForward}
      >
        <ArrowRight size={16} />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={sidebarOpen ? t('收起侧栏') : t('展开侧栏')}
        aria-pressed={sidebarOpen}
        title={
          sidebarLocked
            ? t('设置打开时侧栏保持折叠')
            : `${sidebarOpen ? t('收起侧栏') : t('展开侧栏')}（${shortcutLabel('B')}）`
        }
        disabled={sidebarLocked}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={16} />
      </button>
    </div>
  )
}
