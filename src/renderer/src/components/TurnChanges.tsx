import { useState } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import type { TurnFileChange } from '../store/turn-changes'
import { ChangePath, DiffStat, ToolChangeView } from './ToolChangeView'

/** End-of-turn receipt of what the agent changed on disk, readable without opening the log. */
export default function TurnChanges({
  files,
  projectPath
}: {
  files: TurnFileChange[]
  projectPath?: string
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <section className="turn-changes" aria-label="本轮文件改动">
      <header className="turn-changes-head">
        <FileDiff size={14} aria-hidden="true" />
        <span>已修改 {files.length} 个文件</span>
        <DiffStat additions={additions} deletions={deletions} />
      </header>
      <ul className="turn-changes-list">
        {files.map((file) => {
          const expanded = open === file.path
          return (
            <li key={file.path} className={expanded ? 'is-open' : undefined}>
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
            </li>
          )
        })}
      </ul>
    </section>
  )
}
