import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Hand,
  Plus,
  ShieldAlert,
  ShieldCheck,
  X
} from 'lucide-react'
import type { AgentSnapshot, PermissionMode } from '../../../shared/contracts'
import {
  EMPTY_PERMISSION_RULES,
  permissionRulesSchema,
  type PermissionRules
} from '../../../shared/permission-rules'
import { savePermissionRules } from '../store/permission-rules'
import { t } from '../../../shared/i18n'

const LEVELS = [
  {
    mode: 'ask',
    icon: Hand,
    title: t('请求批准'),
    description: t('写文件、运行命令和网页操作前都会询问')
  },
  {
    mode: 'auto',
    icon: ShieldCheck,
    title: t('帮我批准'),
    description: t('自动批准项目内可撤销的编辑和常规命令，其余仍会询问')
  },
  {
    mode: 'open',
    icon: ShieldAlert,
    title: t('完全访问权限'),
    description: t('不再询问，可运行任何命令、访问项目外文件和网络')
  }
] as const

/** How much Pi may do without asking, remembered per project, plus the project's custom
 * allow rules. Computer Use keeps asking at every level. */
export default function PermissionControl({
  snapshot,
  onPermissionChange
}: {
  snapshot: AgentSnapshot
  onPermissionChange: (permission: PermissionMode) => void
}): React.JSX.Element {
  const rules = snapshot.permissionRules ?? EMPTY_PERMISSION_RULES
  const project = snapshot.project
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ruleCount = rules.commands.length + (rules.projectEdits ? 1 : 0)
  const level = LEVELS.find((item) => item.mode === snapshot.permissionMode) ?? LEVELS[0]
  const LevelIcon = level.icon

  const update = async (next: PermissionRules): Promise<boolean> => {
    if (!project) return false
    const parsed = permissionRulesSchema.safeParse(next)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('规则无效'))
      return false
    }
    try {
      await savePermissionRules(project.path, parsed.data)
      setError(null)
      return true
    } catch (cause) {
      setError(
        (cause instanceof Error ? cause.message : '').replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          ''
        ) || t('保存失败，请重试')
      )
      return false
    }
  }

  const add = async (): Promise<void> => {
    const rule = draft.trim()
    if (!rule) return
    if (rules.commands.includes(rule)) return setDraft('')
    if (await update({ ...rules, commands: [...rules.commands, rule] })) setDraft('')
  }

  return (
    <Popover.Root onOpenChange={() => setError(null)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`tool-chip permission-chip is-${snapshot.permissionMode}`}
          disabled={!project}
          title={level.description}
        >
          <LevelIcon size={14} aria-hidden="true" />
          <span className="chip-label">
            {level.title === t('完全访问权限') ? t('完全访问') : level.title}
          </span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="permission-popover"
          side="top"
          align="start"
          sideOffset={8}
          aria-label={t('工具权限')}
        >
          <p className="permission-heading">
            {t('{value} 可以做什么？', { value: snapshot.runtime?.label ?? 'Agent' })}
            {project ? <span title={project.path}>{project.name}</span> : null}
          </p>
          <div className="permission-modes" role="radiogroup" aria-label={t('工具权限')}>
            {LEVELS.map(({ mode, icon: Icon, title, description }) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={snapshot.permissionMode === mode}
                className={`permission-mode is-${mode}`}
                onClick={() => onPermissionChange(mode)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>
                  <strong>{title}</strong>
                  <small>
                    {snapshot.runtime?.id === 'claude' && mode === 'auto'
                      ? t('自动批准项目内编辑；运行命令和其他操作仍会询问')
                      : description}
                  </small>
                </span>
                {snapshot.permissionMode === mode ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          {(!snapshot.runtime || snapshot.runtime.features.includes('permission-rules')) && (
            <details className="permission-rules">
              <summary>
                <ChevronRight size={13} aria-hidden="true" />

                {t('自定义规则')}
                {ruleCount ? <span>{ruleCount}</span> : null}
              </summary>
              <label className="permission-edits">
                <input
                  type="checkbox"
                  checked={rules.projectEdits}
                  onChange={(event) =>
                    void update({ ...rules, projectEdits: event.target.checked })
                  }
                />
                <span>
                  <strong>{t('自动允许编辑项目内文件')}</strong>
                  <small>{t('在「请求批准」下也生效；每轮改动都可以撤销')}</small>
                </span>
              </label>
              <div className="permission-commands">
                <span className="permission-subtitle">{t('始终允许的命令')}</span>
                {rules.commands.length ? (
                  <ul>
                    {rules.commands.map((rule) => (
                      <li key={rule}>
                        <code>{rule}</code>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t('移除规则 {rule}', { rule })}
                          onClick={() =>
                            void update({
                              ...rules,
                              commands: rules.commands.filter((item) => item !== rule)
                            })
                          }
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t('在确认卡片中选择「总是允许」即可添加，也可以手动输入。')}</p>
                )}
                <form
                  className="permission-add"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void add()
                  }}
                >
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={t('例如 npm test')}
                    aria-label={t('添加始终允许的命令')}
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="icon-btn"
                    aria-label={t('添加规则')}
                    disabled={!draft.trim()}
                  >
                    <Plus size={14} />
                  </button>
                </form>
                <small className="permission-note">
                  {t('按开头的词匹配；含 ; && | 重定向或 $() 的组合命令始终需要确认。')}
                </small>
              </div>
              {error ? (
                <p className="permission-error" role="alert">
                  {error}
                </p>
              ) : null}
            </details>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
