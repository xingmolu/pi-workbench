import type { ReactNode } from 'react'
import { useDesktopSettings } from '../store/desktop-settings'
import '../assets/desktop-settings.css'

export function PreferenceRow({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="desktop-preference-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      {children}
    </label>
  )
}
export function PreferencesFrame({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  const { status, error, hydrate, reset } = useDesktopSettings()
  return (
    <section className="desktop-preferences">
      <h2>{title}</h2>
      <p className="inline-hint">仅影响 Pi Desktop；保存后立即生效。</p>
      {error ? (
        <div role="alert">
          偏好读取或保存失败：{error}
          <button onClick={() => void hydrate()}>重新读取</button>
        </div>
      ) : null}
      <fieldset disabled={status !== 'ready'}>{children}</fieldset>
      <footer>
        <span role="status">
          {status === 'saving'
            ? '正在保存…'
            : status === 'loading' || status === 'idle'
              ? '正在读取…'
              : status === 'ready'
                ? '已与本机保存的设置同步'
                : '未确认保存，请重新读取'}
        </span>
        <button disabled={status !== 'ready'} onClick={() => void reset()}>
          恢复 Desktop 默认设置
        </button>
      </footer>
    </section>
  )
}
export default function GeneralSettings(): React.JSX.Element {
  const { settings, save } = useDesktopSettings()
  return (
    <PreferencesFrame title="常规">
      <PreferenceRow label="发送快捷键" description="Shift + Enter 始终换行；输入法选词不会发送。">
        <select
          value={settings.sendShortcut}
          onChange={(e) =>
            void save({ sendShortcut: e.target.value as 'enter' | 'modifier-enter' })
          }
        >
          <option value="enter">Enter 发送</option>
          <option value="modifier-enter">⌘ / Ctrl + Enter 发送</option>
        </select>
      </PreferenceRow>
      <PreferenceRow label="工作详情" description="工作过程的默认展开方式；单独展开或收起的选择优先。">
        <select
          value={settings.workDetails}
          onChange={(e) => void save({ workDetails: e.target.value as 'compact' | 'expanded' })}
        >
          <option value="compact">紧凑</option>
          <option value="expanded">展开</option>
        </select>
      </PreferenceRow>
      <PreferenceRow
        label="显示用量统计"
        description="在输入框下方显示用量；不影响统计收集和 Context。"
      >
        <input
          type="checkbox"
          checked={settings.showUsage}
          onChange={(e) => void save({ showUsage: e.target.checked })}
        />
      </PreferenceRow>
    </PreferencesFrame>
  )
}
