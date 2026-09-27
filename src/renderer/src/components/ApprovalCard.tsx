import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import type { ApprovalRequest, ToolFileChange } from '../../../shared/contracts'
import { ToolChangeView } from './ToolChangeView'
import { approvalSummary } from '../store/conversation-presentation'
import { approvalPreview } from '../store/approval-presentation'
import '../assets/approval.css'

export type ApprovalHandler = (id: string, allow: boolean) => Promise<boolean> | void

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
      aria-busy={decision !== null ? true : undefined}
    >
      <header className="approval-heading">
        <h3 id={titleId}>{approvalSummary(request)}</h3>
      </header>
      <p className="sr-only" id={descriptionId}>
        仅本次操作。Pi 已暂停此操作，确认后才会执行。
        {projectPath ? <> 会话目录：{projectPath}。</> : null}
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
            aria-label="复制操作内容"
            onClick={() => void copy()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <span className="sr-only" role="status">
            {copied ? '已复制操作内容' : ''}
          </span>
        </div>
      )}
      {preview.parameters !== null ? (
        <details className="approval-parameters">
          <summary>完整操作参数</summary>
          <pre tabIndex={0} aria-label="完整操作参数">
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
            拒绝
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
