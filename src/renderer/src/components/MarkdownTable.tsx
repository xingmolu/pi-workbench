import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps
} from 'react'
import type { Components } from 'react-markdown'
import { markdownTableCells } from './markdown-action-data'
import {
  serializeMarkdownTable,
  type MarkdownTableRequest
} from '../../../shared/markdown-table-export'
import { useMarkdownCopy } from './markdown-copy-action'
import { Check, Copy, Download, Table2 } from 'lucide-react'
import { ActionIcon } from './MessageActions'
import { t } from '../../../shared/i18n'

export const MarkdownActionContext = createContext({ identity: '', streaming: false })
type Props = ComponentProps<Exclude<Components['table'], string | undefined>>
export function MarkdownTable({ node, children }: Props): React.JSX.Element {
  const context = useContext(MarkdownActionContext)
  let cells: string[][] = []
  let invalid = false
  try {
    cells = markdownTableCells(node)
  } catch {
    invalid = true
  }
  const [mode, setMode] = useState<MarkdownTableRequest['mode']>('text-protected')
  const [preview, setPreview] = useState<{ cells: string[][]; streaming: boolean } | null>(null)
  const [rows, setRows] = useState(200)
  const [saveStatus, setSaveStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const previewButton = useRef<HTMLButtonElement>(null)
  const previewRegion = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (preview) {
      previewRegion.current?.focus()
      previewRegion.current?.scrollIntoView({ block: 'start' })
    }
  }, [preview])
  const epoch = context.identity + ':' + node?.position?.start.offset + ':' + JSON.stringify(cells)
  const saveEpoch = useRef(0)
  const savePending = useRef(false)
  useLayoutEffect(() => {
    saveEpoch.current++
    savePending.current = false
    setSaving(false)
    setSaveStatus('')
    return () => {
      saveEpoch.current++
    }
  }, [epoch, mode])
  const { status, copy } = useMarkdownCopy(epoch + ':' + mode)
  useLayoutEffect(() => {
    setPreview(null)
  }, [context.identity, node?.position?.start.offset])
  let payload: ReturnType<typeof serializeMarkdownTable> | null = null
  if (!invalid) {
    try {
      payload = serializeMarkdownTable({ mode, cells }, true)
    } catch {
      invalid = true
    }
  }
  async function save(): Promise<void> {
    if (savePending.current || invalid) return
    savePending.current = true
    const token = saveEpoch.current
    const snapshot = { cells, mode }
    setSaving(true)
    try {
      const result = await window.pi.exportMarkdownTable(snapshot)
      if (token !== saveEpoch.current) return
      setSaveStatus(
        result.status === 'saved'
          ? t('CSV 已保存')
          : result.status === 'cancelled'
            ? t('已取消保存')
            : result.message
      )
    } catch {
      if (token === saveEpoch.current) setSaveStatus(t('保存失败，请重试。'))
    } finally {
      if (token === saveEpoch.current) {
        setSaving(false)
        savePending.current = false
      }
    }
  }
  return (
    <div className="markdown-table-result">
      <div className="markdown-table-toolbar">
        <ActionIcon
          label={
            context.streaming
              ? t('复制当前内容')
              : payload?.format === 'CSV'
                ? t('复制 CSV')
                : t('复制表格')
          }
          hint={
            invalid
              ? t('表格超过导出预算或格式无效')
              : status === 'success'
                ? t('已复制')
                : status === 'pending'
                  ? t('正在复制…')
                  : t('复制表格')
          }
          disabled={invalid || status === 'pending'}
          onClick={() => payload && void copy(payload.text)}
        >
          {status === 'success' ? <Check size={16} /> : <Copy size={16} />}
        </ActionIcon>
        <ActionIcon
          label={t('保存 CSV')}
          hint={invalid ? t('表格超过导出预算或格式无效') : saving ? t('正在保存…') : t('保存 CSV')}
          disabled={invalid || saving}
          onClick={() => void save()}
        >
          <Download size={16} />
        </ActionIcon>
        <ActionIcon
          ref={previewButton}
          label={t('预览表格')}
          hint={invalid ? t('表格超过导出预算或格式无效') : t('预览表格')}
          disabled={invalid}
          onClick={() => {
            setPreview({ cells, streaming: context.streaming })
            setRows(200)
          }}
        >
          <Table2 size={16} />
        </ActionIcon>
        <label className="markdown-table-mode">
          <span className="sr-only">{t('导出方式')}</span>
          <select
            value={mode}
            title={
              mode === 'text-protected'
                ? t(
                    '文本保护：每个单元格（含表头）前加单引号，会改变值；不能保证所有表格软件的公式安全。'
                  )
                : t('原始值：可能被表格软件解释为公式，仅导出可信内容。')
            }
            onChange={(event) => setMode(event.target.value as MarkdownTableRequest['mode'])}
          >
            <option value="text-protected">{t('文本保护')}</option>
            <option value="raw">{t('原始值')}</option>
          </select>
        </label>
      </div>
      {mode === 'raw' ? (
        <p className="markdown-action-note">
          {t('原始值可能被表格软件解释为公式，仅导出可信内容。')}
          {payload?.format === 'CSV' && t(' 含特殊分隔符或使用原始值，复制为 CSV。')}
        </p>
      ) : null}
      {invalid && (
        <p role="status">
          {t('表格超过导出预算（10,000 单元格、200 列、1 MiB）或格式无效，未截断导出。')}
        </p>
      )}
      <div className="markdown-table" tabIndex={0} role="region" aria-label={t('表格，可横向滚动')}>
        <table>{children}</table>
      </div>
      <p role="status" aria-label={t('表格复制结果')}>
        {status === 'error'
          ? t('复制失败，请重试或选中表格手动复制。')
          : status === 'success'
            ? t('表格已复制')
            : ''}
      </p>
      <p role="status" aria-label={t('表格保存结果')}>
        {saveStatus}
      </p>
      {preview && (
        <section
          ref={previewRegion}
          tabIndex={-1}
          className="markdown-table-preview"
          aria-label={t('表格只读预览')}
        >
          <div>
            <span>
              {t('只读预览 · {length} 行', { length: preview.cells.length })}
              {preview.streaming ? t(' · 已捕获流式输出当前快照') : t(' · 点击时快照')}
            </span>{' '}
            <button
              onClick={() => {
                setPreview(null)
                previewButton.current?.focus()
              }}
            >
              {t('关闭预览')}
            </button>
          </div>
          <div
            className="markdown-table"
            tabIndex={0}
            role="region"
            aria-label={t('预览表格，可横向滚动')}
          >
            <table>
              <tbody>
                {preview.cells.slice(0, rows).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows < preview.cells.length && (
            <button onClick={() => setRows(rows + 200)}>
              {t('加载后 200 行（已显示 {rows} 行）', { rows })}
            </button>
          )}
        </section>
      )}
    </div>
  )
}
