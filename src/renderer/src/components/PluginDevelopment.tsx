import { useEffect, useRef, useState } from 'react'
import { FilePlus2, FolderCode, TriangleAlert } from 'lucide-react'
import type { PluginLogLine, PluginTemplate } from '../../../shared/plugin-install'
import { errorText, type PluginInstall } from '../store/plugin-install'
import { t } from '../../../shared/i18n'

const TEMPLATES: { value: PluginTemplate; label: string; hint: string }[] = [
  { value: 'panel', label: t('面板'), hint: t('右侧工作台里的一个页面') },
  { value: 'command', label: t('命令'), hint: t('出现在 ⌘K 里，由插件进程执行') },
  { value: 'agent-tool', label: t('Agent 工具'), hint: t('给 Agent 用的工具') }
]

/** `My Notes` → `local.my-notes`; authors can change it to their own namespace. */
function suggestedId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `local.${slug || 'plugin'}`
}

/** Creating a plugin from a template, or loading one from its folder, for development. */
export function PluginDevelopmentTools({ install }: { install: PluginInstall }): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [template, setTemplate] = useState<PluginTemplate>('panel')
  const disabled = install.busy || install.preview !== null
  const pluginId = idEdited ? id : suggestedId(name)
  const broken = install.development.filter((folder) => folder.pluginId === null)

  return (
    <section className="plugin-development" aria-label={t('开发插件')}>
      <div className="plugin-development-head">
        <div>
          <strong>{t('开发插件')}</strong>
          <p>
            {t(
              '直接从文件夹加载，文件一改就自动重新加载。日志里能看到插件进程的输出和面板的控制台。'
            )}
          </p>
        </div>
        <div className="plugin-install-buttons">
          <button
            type="button"
            aria-expanded={creating}
            disabled={disabled}
            onClick={() => setCreating((open) => !open)}
          >
            <FilePlus2 size={13} aria-hidden="true" />
            {t('新建插件')}
          </button>
          <button type="button" disabled={disabled} onClick={() => void install.develop()}>
            <FolderCode size={13} aria-hidden="true" />
            {t('加载开发中的插件')}
          </button>
        </div>
      </div>
      {creating ? (
        <form
          className="plugin-create"
          aria-label={t('新建插件')}
          onSubmit={(event) => {
            event.preventDefault()
            void install.scaffold({ template, id: pluginId, name: name.trim() }).then((done) => {
              if (!done) return
              setCreating(false)
              setName('')
              setIdEdited(false)
            })
          }}
        >
          <label>
            <span>{t('名称')}</span>
            <input
              value={name}
              maxLength={80}
              placeholder="My Notes"
              disabled={disabled}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>{t('插件 id')}</span>
            <input
              value={pluginId}
              maxLength={128}
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => {
                setIdEdited(true)
                setId(event.target.value)
              }}
            />
          </label>
          <fieldset>
            <legend>{t('模板')}</legend>
            {TEMPLATES.map((option) => (
              <label key={option.value} className="plugin-template">
                <input
                  type="radio"
                  name="plugin-template"
                  value={option.value}
                  checked={template === option.value}
                  disabled={disabled}
                  onChange={() => setTemplate(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="plugin-grant-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => setCreating(false)}
            >
              {t('取消')}
            </button>
            <button type="submit" className="primary-button" disabled={disabled || !name.trim()}>
              {t('选择位置并创建')}
            </button>
          </div>
        </form>
      ) : null}
      {broken.map((folder) => (
        <div
          className="plugin-development-folder"
          key={folder.path}
          role="group"
          aria-label={folder.path}
        >
          <TriangleAlert size={13} aria-hidden="true" />
          <div>
            <code title={folder.path}>{folder.path}</code>
            <p>{t('未能加载：{reason}', { reason: folder.problem ?? '' })}</p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void install.undevelop(folder.path)}
          >
            {t('移除')}
          </button>
        </div>
      ))}
    </section>
  )
}

const LEVEL_LABEL: Record<PluginLogLine['level'], string> = {
  info: '',
  warning: t('警告'),
  error: t('错误')
}

/** The plugin's recent output, refreshed while open. */
export function PluginLogView({ pluginId }: { pluginId: string }): React.JSX.Element {
  const [lines, setLines] = useState<PluginLogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const result = await window.pi.pluginInstall({ type: 'logs', pluginId })
        if (!stopped && result.type === 'logs') setLines(result.lines)
      } catch (failure) {
        if (!stopped) setError(errorText(failure))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 1000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [pluginId])

  useEffect(() => {
    const element = list.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lines.length])

  return (
    <div className="plugin-logs" role="region" aria-label={t('插件日志')}>
      {error ? <p role="alert">{error}</p> : null}
      {lines.length === 0 ? (
        <p className="plugin-logs-empty">
          {t('还没有输出。console.log 和面板的控制台消息会显示在这里。')}
        </p>
      ) : (
        <ol ref={list}>
          {lines.map((line, index) => (
            <li key={`${line.at}-${index}`} className={`is-${line.level}`}>
              <time>{new Date(line.at).toLocaleTimeString()}</time>
              {line.source ? <span className="plugin-log-source">{t('面板')}</span> : null}
              {LEVEL_LABEL[line.level] ? (
                <span className="plugin-log-level">{LEVEL_LABEL[line.level]}</span>
              ) : null}
              <span className="plugin-log-text">{line.text}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="plugin-logs-actions">
        <button
          type="button"
          onClick={() =>
            void window.pi.pluginInstall({ type: 'clear-logs', pluginId }).then(() => setLines([]))
          }
        >
          {t('清空')}
        </button>
      </div>
    </div>
  )
}
