import { useMemo, useState } from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { PierrePatchDiff, preparePatchLanguage } from './PierrePatchDiff'
import type { GitReviewResult } from '../../../shared/git-review'

type Patch = Extract<GitReviewResult, { type: 'patch' }>
const kindLabels = {
  text: '文本差异',
  binary: '二进制文件',
  conflict: '合并冲突',
  submodule: '子模块',
  'type-only': '文件类型或权限变化',
  empty: '没有文本差异',
  untracked: '未跟踪文件'
}

export default function GitPatchView({ patch }: { patch: Patch }): React.JSX.Element {
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified')
  const [raw, setRaw] = useState(false)
  const parsed = useMemo(() => {
    const text = patch.text
    if (!text) return { reason: '', files: null }
    if (patch.rawOnly) return { reason: '包含非 UTF-8 字节，以转义文本完整显示', files: null }
    if (text.length > 200_000 || text.split('\n').length > 2_000)
      return { reason: '差异较大，以完整原始文本显示', files: null }
    if (patch.kind !== 'text') return { reason: kindLabels[patch.kind], files: null }
    try {
      const patches = parsePatchFiles(text, undefined, true)
      const files = patches[0]?.files
      if (patches.length !== 1 || files?.length !== 1 || !files[0]?.hunks.length)
        return { reason: '无法解析为文本差异，保留完整内容', files: null }
      preparePatchLanguage(files[0])
      return { reason: '', files }
    } catch {
      return { reason: '无法解析为文本差异，保留完整内容', files: null }
    }
  }, [patch])

  return (
    <div className="git-patch">
      {patch.kind !== 'text' && (
        <p className="git-message" role="status">
          {kindLabels[patch.kind]} · {patch.message}
        </p>
      )}
      {parsed.files ? (
        <>
          <div className="git-diff-controls" aria-label="差异布局">
            <button
              type="button"
              aria-pressed={!raw && viewType === 'unified'}
              onClick={() => {
                setViewType('unified')
                setRaw(false)
              }}
            >
              统一
            </button>
            <button
              type="button"
              aria-pressed={!raw && viewType === 'split'}
              onClick={() => {
                setViewType('split')
                setRaw(false)
              }}
            >
              分栏
            </button>
            <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
              原始差异
            </button>
          </div>
          {raw ? (
            <pre tabIndex={0} aria-label="原始差异">
              {patch.text}
            </pre>
          ) : (
            <div className="git-diff-scroll" tabIndex={0} aria-label="文件差异">
              <PierrePatchDiff patch={patch.text!} layout={viewType} />
            </div>
          )}
        </>
      ) : patch.text ? (
        <>
          <p className="git-message">原始差异 · {parsed.reason}</p>
          <pre tabIndex={0} aria-label="原始差异">
            {patch.text}
          </pre>
        </>
      ) : patch.kind === 'text' ? (
        <p className="git-message" role="alert">
          未收到文本差异，请刷新重试
        </p>
      ) : null}
    </div>
  )
}
