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
          ? 'CSV 已保存'
          : result.status === 'cancelled'
            ? '已取消保存'
            : result.message
      )
    } catch {
      if (token === saveEpoch.current) setSaveStatus('保存失败，请重试。')
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
          label={context.streaming?'复制当前内容':payload?.format==='CSV'?'复制 CSV':'复制表格'}
          hint={invalid?'表格超过导出预算或格式无效':status==='success'?'已复制':status==='pending'?'正在复制…':'复制表格'}
          disabled={invalid || status === 'pending'}
          onClick={() => payload && void copy(payload.text)}
        >
          {status==='success'?<Check size={16}/>:<Copy size={16}/>}
        </ActionIcon>
        <ActionIcon label="保存 CSV" hint={invalid?'表格超过导出预算或格式无效':saving?'正在保存…':'保存 CSV'} disabled={invalid || saving} onClick={() => void save()}><Download size={16}/></ActionIcon>
        <ActionIcon
          ref={previewButton}
          label="预览表格"
          hint={invalid?'表格超过导出预算或格式无效':'预览表格'}
          disabled={invalid}
          onClick={() => {
            setPreview({ cells, streaming: context.streaming })
            setRows(200)
          }}
        >
          <Table2 size={16}/>
        </ActionIcon>
        <label>
          导出方式{' '}
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as MarkdownTableRequest['mode'])}
          >
            <option value="text-protected">文本保护</option>
            <option value="raw">原始值</option>
          </select>
        </label>
      </div>
      <p className="markdown-action-note">
        {mode === 'text-protected'
          ? '每个单元格（含表头）前加单引号，会改变值；不能保证所有表格软件的公式安全。'
          : '原始值可能被表格软件解释为公式，仅导出可信内容。'}
        {payload?.format === 'CSV' && ' 含特殊分隔符或使用原始值，复制为 CSV。'}
      </p>
      {invalid && (
        <p role="status">
          表格超过导出预算（10,000 单元格、200 列、1 MiB）或格式无效，未截断导出。
        </p>
      )}
      <div className="markdown-table" tabIndex={0} role="region" aria-label="表格，可横向滚动">
        <table>{children}</table>
      </div>
      <p role="status" aria-label="表格复制结果">
        {status === 'error'
          ? '复制失败，请重试或选中表格手动复制。'
          : status === 'success'
            ? '表格已复制'
            : ''}
      </p>
      <p role="status" aria-label="表格保存结果">
        {saveStatus}
      </p>
      {preview && (
        <section
          ref={previewRegion}
          tabIndex={-1}
          className="markdown-table-preview"
          aria-label="表格只读预览"
        >
          <div>
            <span>
              只读预览 · {preview.cells.length} 行
              {preview.streaming ? ' · 已捕获流式输出当前快照' : ' · 点击时快照'}
            </span>{' '}
            <button
              onClick={() => {
                setPreview(null)
                previewButton.current?.focus()
              }}
            >
              关闭预览
            </button>
          </div>
          <div
            className="markdown-table"
            tabIndex={0}
            role="region"
            aria-label="预览表格，可横向滚动"
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
            <button onClick={() => setRows(rows + 200)}>加载后 200 行（已显示 {rows} 行）</button>
          )}
        </section>
      )}
    </div>
  )
}
