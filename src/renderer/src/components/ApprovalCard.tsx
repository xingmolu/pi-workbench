import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle, ShieldQuestion } from 'lucide-react'
import type { ApprovalRequest } from '../../../shared/contracts'
import { approvalSummary } from '../store/conversation-presentation'
import { approvalPreview } from '../store/approval-presentation'
import '../assets/approval.css'

export type ApprovalHandler = (id: string, allow: boolean) => Promise<boolean> | void

/** One decision surface per request. An acknowledgement is not execution success. */
export default function ApprovalCard({
  request,
  projectPath,
  onApproval
}: {
  request: ApprovalRequest
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

  const respond = async (allow: boolean): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setDecision(allow ? 'allow' : 'deny')
    setError(null)
    try {
      const accepted = await onApproval(request.id, allow)
      if (accepted === false) throw new Error('确认未能提交，请重试。')
      if (mounted.current) setSubmitted(true)
      // Keep locked until the authoritative request disappears, not just until IPC resolves.
    } catch {
      inFlight.current = false
      if (mounted.current) {
        setDecision(null)
        setError('确认未能提交，请重试。')
      }
    }
  }
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(preview.text)
      if (mounted.current) setCopied(true)
    } catch {
      if (mounted.current) setError('复制失败，请选中操作内容后复制。')
    }
  }

  return (
    <section
      className="approval-card"
      data-approval-id={request.id}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={decision !== null || undefined}
    >
      <header className="approval-heading">
        <span className="approval-symbol" aria-hidden="true">
          <ShieldQuestion size={18} />
        </span>
        <div className="approval-heading-copy">
          <div className="approval-kicker">需要你的确认</div>
          <h3 id={titleId}>{approvalSummary(request)}</h3>
        </div>
        <span className="approval-scope">仅本次操作</span>
      </header>
      <p className="approval-description" id={descriptionId}>
        Pi 已暂停此操作，确认后才会执行。
      </p>
      <div className="approval-preview">
        <div className="approval-preview-header">
          <span>{preview.label}</span>
          <span className="approval-tool-name">{request.toolName}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="复制操作内容"
            onClick={() => void copy()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <span className="sr-only" role="status">
            {copied ? '已复制操作内容' : ''}
          </span>
        </div>
        <pre tabIndex={0} aria-label={preview.label}>
          {preview.text}
        </pre>
      </div>
      {preview.parameters !== null && (
        <details className="approval-parameters" open>
          <summary>完整操作参数</summary>
          <pre tabIndex={0} aria-label="完整操作参数">
            {preview.parameters}
          </pre>
        </details>
      )}
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
      <footer className="approval-footer">
        <span className="approval-project" title={projectPath}>
          {projectPath ? `会话目录 · ${projectPath}` : '本次确认不会更改默认权限'}
        </span>
        <div className="approval-actions" data-approval-actions={request.id}>
          <button
            type="button"
            className="secondary-button"
            disabled={decision !== null}
            onClick={() => void respond(false)}
          >
            {decision === 'deny' && !submitted ? (
              <LoaderCircle className="approval-spinner" size={14} aria-hidden="true" />
            ) : null}
            拒绝
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={decision !== null}
            onClick={() => void respond(true)}
          >
            {decision === 'allow' && !submitted ? (
              <LoaderCircle className="approval-spinner" size={14} aria-hidden="true" />
            ) : null}
            允许一次
          </button>
        </div>
      </footer>
      <span className="approval-submit-status" role="status">
        {decision !== null ? (submitted ? '已提交，等待操作状态更新…' : '正在提交确认…') : ''}
      </span>
    </section>
  )
}
