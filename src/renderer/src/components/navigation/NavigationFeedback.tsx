import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { performNavigationAction, useNavigationFeedback } from '../../store/navigation-feedback'
import { useNavigationLibrary } from '../../store/navigation-library'
import { t } from '../../../../shared/i18n'

export default function NavigationFeedback(): React.JSX.Element | null {
  const { notice, dismiss } = useNavigationFeedback()
  const pending = useNavigationLibrary((state) => state.pending > 0)
  if (!notice) return null
  return (
    <div
      className={`navigation-toast${notice.error ? ' is-error' : ''}`}
      role={notice.error ? 'alert' : 'status'}
    >
      {notice.error ? <CircleAlert size={17} /> : <CircleCheck size={17} />}
      <span>{notice.message}</span>
      {notice.undo && (
        <button
          disabled={pending}
          onClick={() => {
            void performNavigationAction(notice.undo!, t('已撤销操作'))
          }}
        >
          {t('撤销')}
        </button>
      )}
      <button className="icon-btn" onClick={dismiss} aria-label={t('关闭提示')}>
        <X size={15} />
      </button>
    </div>
  )
}
