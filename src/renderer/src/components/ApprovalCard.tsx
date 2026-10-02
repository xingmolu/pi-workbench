import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import type { ApprovalRequest, ApprovalScope, ToolFileChange } from '../../../shared/contracts'
import { ToolChangeView } from './ToolChangeView'
import { usePiStore } from '../store/pi-store'
import { savePermissionRules } from '../store/permission-rules'
import {
  EMPTY_PERMISSION_RULES,
  suggestCommandRule,
  type PermissionRules
} from '../../../shared/permission-rules'

/** The rule an approval can turn into, or null when none would be safe or useful. */
function alwaysAllow(
  request: ApprovalRequest,
  change: ToolFileChange | undefined,
  projectPath: string | undefined,
  rules: PermissionRules
): { label: string; next: PermissionRules } | null {
  if (!projectPath) return null
  if (request.toolName === 'bash' || request.toolName === 'powershell') {
    let command: unknown
    try {
      command = (JSON.parse(request.detail) as { command?: unknown }).command
    } catch {
      return null
    }
    const rule = typeof command === 'string' ? suggestCommandRule(command) : null
    if (!rule || rules.commands.includes(rule)) return null
    return {
      label: t('总是允许 {rule}', { rule }),
      next: { ...rules, commands: [...rules.commands, rule] }
    }
  }
  if (
    (request.toolName === 'write' || request.toolName === 'edit') &&
    change &&
    !rules.projectEdits
  ) {
    const root = projectPath.replace(/[\\/]+$/, '')
    const inside =
      !change.path.includes('..') &&
      (!/^([\\/]|[A-Za-z]:)/.test(change.path) ||
        change.path.startsWith(`${root}/`) ||
        change.path.startsWith(`${root}\\`))
    // The Host re-checks the resolved, symlink-free path before honoring the rule.
    return inside
      ? { label: t('总是允许编辑项目文件'), next: { ...rules, projectEdits: true } }
      : null
  }
  return null
}
import { approvalSummary } from '../store/conversation-presentation'
import { approvalPreview } from '../store/approval-presentation'
import { t } from '../../../shared/i18n'
import '../assets/approval.css'

export type ApprovalHandler = (
  id: string,
  allow: boolean,
  scope?: ApprovalScope
) => Promise<boolean> | void

/** One compact decision surface per request. An acknowledgement is not execution success. */
export default function ApprovalCard({
  request,
  change,
  projectPath,
  onApproval
}: {
  request: ApprovalRequest
  /** The proposed file change for write/edit requests, shown before anything is written. */
  change?: ToolFileChange
  projectPath?: string
  onApproval: ApprovalHandler
}): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const [decision, setDecision] = useState<'allow' | 'deny' | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const preview = approvalPreview(request)
  const rules = usePiStore((state) => state.snapshot.permissionRules) ?? EMPTY_PERMISSION_RULES
  const always = alwaysAllow(request, change, projectPath, rules)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timeout)
  }, [copied])

  const respond = async (
    allow: boolean,
    rule?: PermissionRules,
    scope?: ApprovalScope
  ): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setDecision(allow ? 'allow' : 'deny')
    setError(null)
    try {
      if (rule && projectPath) await savePermissionRules(projectPath, rule)
      const accepted = await onApproval(request.id, allow, scope)
      if (accepted === false) throw new Error(t('确认未能提交，请重试。'))
      if (mounted.current) setSubmitted(true)
      // Keep locked until the authoritative request disappears, not just until IPC resolves.
    } catch {
      inFlight.current = false
      if (mounted.current) {
        setDecision(null)
        setError(t('确认未能提交，请重试。'))
      }
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(preview.text)
      if (mounted.current) setCopied(true)
    } catch {
      if (mounted.current) setError(t('复制失败，请选中操作内容后复制。'))
    }
  }

  return (
    <section
      className="approval-card"
      data-approval-id={request.id}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={decision !== null ? true : undefined}
    >
      <header className="approval-heading">
        <h3 id={titleId}>{approvalSummary(request)}</h3>
      </header>
      <p className="sr-only" id={descriptionId}>
        {t('仅本次操作。Pi 已暂停此操作，确认后才会执行。')}
        {projectPath ? <> {t('会话目录：{projectPath}。', { projectPath })}</> : null}
      </p>
      {change ? (
        <ToolChangeView change={change} projectPath={projectPath} />
      ) : (
        <div className="approval-preview">
          <pre tabIndex={0} aria-label={preview.label}>
            {preview.text}
          </pre>
          <button
            type="button"
            className="icon-btn approval-copy"
            aria-label={t('复制操作内容')}
            onClick={() => void copy()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <span className="sr-only" role="status">
            {copied ? t('已复制操作内容') : ''}
          </span>
        </div>
      )}
      {preview.parameters !== null ? (
        <details className="approval-parameters">
          <summary>{t('完整操作参数')}</summary>
          <pre tabIndex={0} aria-label={t('完整操作参数')}>
            {preview.parameters}
          </pre>
        </details>
      ) : null}
      {error ? (
        <p className="approval-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="approval-footer">
        {request.grant ? (
          <button
            type="button"
            className="approval-always"
            disabled={decision !== null}
            title={t('这次任务结束前，操作这个应用不再逐次询问')}
            onClick={() => void respond(true, undefined, 'turn')}
          >
            {t('本轮允许操作 {app}', { app: request.grant.app })}
          </button>
        ) : null}
        {always ? (
          <button
            type="button"
            className="approval-always"
            disabled={decision !== null}
            title={t('保存为这个项目的规则，并允许这一次')}
            onClick={() => void respond(true, always.next)}
          >
            {always.label}
          </button>
        ) : null}
        <div className="approval-actions" data-approval-actions={request.id}>
          <button
            type="button"
            className="secondary-button"
            disabled={decision !== null}
            onClick={() => void respond(false)}
          >
            {decision === 'deny' && !submitted ? (
              <LoaderCircle className="approval-spinner" size={13} aria-hidden="true" />
            ) : null}

            {t('拒绝')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={decision !== null}
            onClick={() => void respond(true)}
          >
            {decision === 'allow' && !submitted ? (
              <LoaderCircle className="approval-spinner" size={13} aria-hidden="true" />
            ) : null}

            {t('允许一次')}
          </button>
        </div>
      </footer>
      <span className="approval-submit-status" role="status">
        {decision !== null ? (submitted ? t('已提交，等待操作状态更新…') : t('正在提交确认…')) : ''}
      </span>
    </section>
  )
}
