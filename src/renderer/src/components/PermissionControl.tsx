import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Plus, ShieldCheck, ShieldAlert, X } from 'lucide-react'
import type { AgentSnapshot, PermissionMode } from '../../../shared/contracts'
import {
  EMPTY_PERMISSION_RULES,
  permissionRulesSchema,
  type PermissionRules
} from '../../../shared/permission-rules'
import { savePermissionRules } from '../store/permission-rules'

/** One compact chip for how much Pi may do without asking: the run-wide mode plus the
 * project's persistent allow rules. */
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
  const open = snapshot.permissionMode === 'open'
  const label = open ? '已开放' : ruleCount ? `需确认 · ${ruleCount} 条规则` : '需确认'

  const update = async (next: PermissionRules): Promise<boolean> => {
    if (!project) return false
    const parsed = permissionRulesSchema.safeParse(next)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '规则无效')
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
        ) || '保存失败，请重试'
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
          title={
            open
              ? '本次运行允许 Pi 直接使用工具'
              : '写文件、运行命令和网页交互需要确认；规则内的操作除外'
          }
        >
          {open ? (
            <ShieldAlert size={14} aria-hidden="true" />
          ) : (
            <ShieldCheck size={14} aria-hidden="true" />
          )}
          <span className="chip-label">{label}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="permission-popover"
          side="top"
          align="start"
          sideOffset={8}
          aria-label="工具权限"
        >
          <div className="permission-modes" role="radiogroup" aria-label="工具权限">
            {(
              [
                ['ask', '操作需确认', '写文件、运行命令和网页交互需要确认，规则内的除外'],
                ['open', '本次运行开放工具', '本次运行允许 Pi 直接使用工具，重启后恢复为需确认']
              ] as const
            ).map(([mode, title, description]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={snapshot.permissionMode === mode}
                className="permission-mode"
                onClick={() => onPermissionChange(mode)}
              >
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
                {snapshot.permissionMode === mode ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          <section className="permission-rules" aria-label="项目规则">
            <header>
              <strong>项目规则</strong>
              {project ? <span title={project.path}>{project.name}</span> : null}
            </header>
            <label className="permission-edits">
              <input
                type="checkbox"
                checked={rules.projectEdits}
                onChange={(event) => void update({ ...rules, projectEdits: event.target.checked })}
              />
              <span>
                <strong>自动允许编辑项目内文件</strong>
                <small>每轮改动都可以在改动汇总中撤销</small>
              </span>
            </label>
            <div className="permission-commands">
              <span className="permission-subtitle">始终允许的命令</span>
              {rules.commands.length ? (
                <ul>
                  {rules.commands.map((rule) => (
                    <li key={rule}>
                      <code>{rule}</code>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`移除规则 ${rule}`}
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
                <p>在确认卡片中选择「总是允许」即可添加，也可以手动输入。</p>
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
                  placeholder="例如 npm test"
                  aria-label="添加始终允许的命令"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  className="icon-btn"
                  aria-label="添加规则"
                  disabled={!draft.trim()}
                >
                  <Plus size={14} />
                </button>
              </form>
              <small className="permission-note">
                按开头的词匹配；含 ; &amp;&amp; | 重定向或 $() 的组合命令始终需要确认。
              </small>
            </div>
            {error ? (
              <p className="permission-error" role="alert">
                {error}
              </p>
            ) : null}
          </section>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
