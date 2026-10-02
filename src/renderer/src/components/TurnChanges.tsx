import { useEffect, useRef, useState } from 'react'
import { useRevealOnOpen } from './use-reveal-on-open'
import { ChevronRight, FileDiff, LoaderCircle, RotateCcw } from 'lucide-react'
import type { TurnFileChange } from '../store/turn-changes'
import type { CheckpointPlan, CheckpointTurnState } from '../../../shared/checkpoints'
import { ChangePath, DiffStat, ToolChangeView } from './ToolChangeView'
import { t } from '../../../shared/i18n'

export type TurnCheckpoint = {
  entryId: string
  state: CheckpointTurnState['state']
  sessionId: string
  generation: number
  /** Why undo is unavailable right now (e.g. the agent is still running). */
  blockedReason: string | null
}

type Undo =
  | { phase: 'idle' }
  | { phase: 'planning' }
  | { phase: 'confirm'; plan: CheckpointPlan }
  | { phase: 'restoring'; plan: CheckpointPlan }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string }

/** End-of-turn receipt of what the agent changed on disk, readable without opening the log. */
export default function TurnChanges({
  files,
  projectPath,
  checkpoint
}: {
  files: TurnFileChange[]
  projectPath?: string
  checkpoint?: TurnCheckpoint
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [undo, setUndo] = useState<Undo>({ phase: 'idle' })
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const restored = checkpoint?.state === 'restored'

  const plan = async (): Promise<void> => {
    if (!checkpoint) return
    setUndo({ phase: 'planning' })
    try {
      const result = await window.pi.send({
        type: 'checkpoint:plan',
        sessionId: checkpoint.sessionId,
        generation: checkpoint.generation,
        entryId: checkpoint.entryId
      })
      setUndo(
        result.plan
          ? { phase: 'confirm', plan: result.plan }
          : { phase: 'error', message: t('这一轮没有可撤销的文件改动。') }
      )
    } catch (error) {
      setUndo({ phase: 'error', message: messageOf(error) })
    }
  }

  const restore = async (plan: CheckpointPlan, force: boolean): Promise<void> => {
    if (!checkpoint) return
    setUndo({ phase: 'restoring', plan })
    try {
      const { outcome } = await window.pi.send({
        type: 'checkpoint:restore',
        sessionId: checkpoint.sessionId,
        generation: checkpoint.generation,
        entryId: checkpoint.entryId,
        force
      })
      if (!outcome || outcome.status === 'unavailable')
        setUndo({ phase: 'error', message: t('改动记录已不可用。') })
      else if (outcome.status === 'conflict') setUndo({ phase: 'confirm', plan: outcome.plan })
      else if (!outcome.skipped.length && !outcome.failed.length)
        // The header switches to "已撤销" from the snapshot; no second confirmation line.
        setUndo({ phase: 'idle' })
      else
        setUndo({
          phase: 'done',
          message: [
            t('已撤销 {restored} 个文件', { restored: outcome.restored }),
            outcome.skipped.length
              ? t('{length} 个无法还原', { length: outcome.skipped.length })
              : '',
            outcome.failed.length
              ? t('{length} 个写入失败，可重试', { length: outcome.failed.length })
              : ''
          ]
            .filter(Boolean)
            .join('，')
        })
    } catch (error) {
      setUndo({ phase: 'error', message: messageOf(error) })
    }
  }

  return (
    <section
      className={`turn-changes${restored ? ' is-restored' : ''}`}
      aria-label={t('本轮文件改动')}
    >
      <header className="turn-changes-head">
        <FileDiff size={14} aria-hidden="true" />
        <span>
          {restored ? t('已撤销') : t('已修改')} {t('{length} 个文件', { length: files.length })}
        </span>
        <DiffStat additions={additions} deletions={deletions} />
        {checkpoint && !restored && undo.phase !== 'confirm' && undo.phase !== 'restoring' ? (
          <button
            type="button"
            className="turn-undo"
            disabled={Boolean(checkpoint.blockedReason) || undo.phase === 'planning'}
            title={checkpoint.blockedReason ?? t('把这些文件还原到这一轮开始之前')}
            onClick={() => void plan()}
          >
            {undo.phase === 'planning' ? (
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
            ) : (
              <RotateCcw size={13} aria-hidden="true" />
            )}

            {t('撤销')}
          </button>
        ) : null}
      </header>
      {undo.phase === 'confirm' || undo.phase === 'restoring' ? (
        <UndoConfirm
          plan={undo.plan}
          projectPath={projectPath}
          busy={undo.phase === 'restoring'}
          onCancel={() => setUndo({ phase: 'idle' })}
          onConfirm={(force) => void restore(undo.plan, force)}
        />
      ) : null}
      {undo.phase === 'done' || undo.phase === 'error' ? (
        <p className={`turn-undo-status${undo.phase === 'error' ? ' is-error' : ''}`} role="status">
          {undo.message}
        </p>
      ) : null}
      <ul className="turn-changes-list">
        {files.map((file) => {
          const expanded = open === file.path
          return (
            <ChangeItem key={file.path} expanded={expanded}>
              <button
                type="button"
                className="turn-change-row"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : file.path)}
              >
                <ChevronRight className="turn-change-chevron" size={13} aria-hidden="true" />
                <ChangePath path={file.path} projectPath={projectPath} />
                <DiffStat additions={file.additions} deletions={file.deletions} />
              </button>
              {expanded ? (
                <div className="turn-change-diffs">
                  {file.changes.map((change, index) => (
                    <ToolChangeView
                      key={index}
                      change={change}
                      projectPath={projectPath}
                      header={file.changes.length > 1}
                    />
                  ))}
                </div>
              ) : null}
            </ChangeItem>
          )
        })}
      </ul>
    </section>
  )
}

function ChangeItem({
  expanded,
  children
}: {
  expanded: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const item = useRevealOnOpen<HTMLLIElement>(expanded)
  return (
    <li ref={item} className={expanded ? 'is-open' : undefined}>
      {children}
    </li>
  )
}

function UndoConfirm({
  plan,
  projectPath,
  busy,
  onCancel,
  onConfirm
}: {
  plan: CheckpointPlan
  projectPath?: string
  busy: boolean
  onCancel: () => void
  onConfirm: (force: boolean) => void
}): React.JSX.Element {
  const conflicts = plan.files.filter((file) => file.status === 'conflict').length
  const restorable = plan.files.filter((file) => file.status !== 'uncaptured').length
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])
  return (
    <div className="turn-undo-confirm" role="group" aria-label={t('确认撤销')} ref={panel}>
      <p>
        {t('把下列文件还原到这一轮开始之前。')}
        {plan.laterTurns
          ? t('之后 {laterTurns} 轮对这些文件的改动也会一并撤销。', { laterTurns: plan.laterTurns })
          : ''}

        {t('命令行产生的改动不会还原，对话记录保持不变。')}
      </p>
      <ul>
        {plan.files.map((file) => (
          <li key={file.path} className={`is-${file.status}`}>
            <ChangePath path={file.path} projectPath={projectPath} />
            <span>
              {file.status === 'uncaptured'
                ? t('无法还原')
                : file.status === 'conflict'
                  ? t('之后被改动过')
                  : file.action === 'delete'
                    ? t('删除')
                    : t('还原')}
            </span>
          </li>
        ))}
      </ul>
      <div className="turn-undo-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
          {t('取消')}
        </button>
        <button
          type="button"
          className={conflicts ? 'danger-button' : 'primary-button'}
          disabled={busy || restorable === 0}
          onClick={() => onConfirm(conflicts > 0)}
        >
          {busy ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : null}
          {conflicts ? t('覆盖 {conflicts} 个文件并撤销', { conflicts }) : t('撤销改动')}
        </button>
      </div>
    </div>
  )
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Electron prefixes errors thrown across invoke(); show only the Host's own reason.
  return (
    message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') ||
    t('撤销失败，请重试。')
  )
}
