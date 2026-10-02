import { memo } from 'react'
import type { ToolFileChange } from '../../../shared/contracts'
import { PierrePatchDiff } from './PierrePatchDiff'
import { displayChangePath } from '../store/turn-changes'
import { t } from '../../../shared/i18n'

export function DiffStat({
  additions,
  deletions
}: {
  additions: number
  deletions: number
}): React.JSX.Element {
  return (
    <span
      className="diff-stat"
      aria-label={t('新增 {additions} 行，删除 {deletions} 行', { additions, deletions })}
    >
      {additions ? <span className="diff-stat-add">+{additions}</span> : null}
      {deletions ? <span className="diff-stat-del">−{deletions}</span> : null}
      {!additions && !deletions ? <span>0</span> : null}
    </span>
  )
}

export function ChangePath({
  path,
  projectPath
}: {
  path: string
  projectPath?: string
}): React.JSX.Element {
  const { dir, name } = displayChangePath(path, projectPath)
  return (
    <span className="change-path" title={path}>
      {dir ? <span className="change-path-dir">{dir}</span> : null}
      <span className="change-path-name">{name}</span>
    </span>
  )
}

/** A single tool call's file change. Proposed edits are located against the model's snippet,
 * so their gutters stay hidden instead of showing fake file line numbers. */
export const ToolChangeView = memo(function ToolChangeView({
  change,
  projectPath,
  header = true
}: {
  change: ToolFileChange
  projectPath?: string
  header?: boolean
}): React.JSX.Element {
  const label =
    change.source === 'proposed'
      ? change.kind === 'write'
        ? t('拟写入')
        : t('拟修改')
      : change.kind === 'write'
        ? t('已写入')
        : t('已修改')
  return (
    <section className={`tool-change is-${change.source}`} aria-label={`${label} ${change.path}`}>
      {header ? (
        <header className="tool-change-head">
          <ChangePath path={change.path} projectPath={projectPath} />
          <span className="tool-change-label">{label}</span>
          <DiffStat additions={change.additions} deletions={change.deletions} />
        </header>
      ) : null}
      {change.omitted ? (
        <p className="tool-change-omitted">
          {t('改动较大，未在对话中展开。可在「审查」中查看完整差异。')}
        </p>
      ) : (
        <div className="tool-change-body">
          <PierrePatchDiff patch={change.patch} layout="unified" lineNumbers={change.anchored} />
        </div>
      )}
    </section>
  )
})
