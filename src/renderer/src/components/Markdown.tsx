import { memo, useContext, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { useDesktopSettings } from '../store/desktop-settings'
import remarkGfm from 'remark-gfm'
import { MarkdownTable, MarkdownActionContext } from './MarkdownTable'
import { useMarkdownCopy } from './markdown-copy-action'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { Check, Copy, WrapText } from 'lucide-react'
import { ActionIcon } from './MessageActions'
import { HighlightedCode } from './HighlightedCode'

type PreProps = ComponentProps<Exclude<Components['pre'], string | undefined>>
type PreNode = PreProps['node']

export function codeBlockText(node: PreNode): string {
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  if (!code || code.type !== 'element') return ''
  const value = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
  // mdast-to-hast appends one LF to a nonempty code value. Preserve all source whitespace.
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

function CodeBlock({ node }: PreProps): React.JSX.Element {
  const value = codeBlockText(node)
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const language = Array.isArray(classes)
    ? String(classes.find((name) => String(name).startsWith('language-')) ?? '').slice(9)
    : ''
  const defaultWrap = useDesktopSettings(state => state.settings.codeWrap)
  const [wrapOverride, setWrap] = useState<boolean | null>(null)
  const wrap = wrapOverride ?? defaultWrap
  const context = useContext(MarkdownActionContext)
  const { status, copy } = useMarkdownCopy(
    context.identity + ':' + node?.position?.start.offset + ':' + value
  )

  return (
    <div className={`code-block${wrap ? ' is-wrapped' : ''}`}>
      <div className="code-block-toolbar">
        <span className="code-block-language" title={language || '代码'}>
          {language || '代码'}
        </span>
        <ActionIcon label="自动换行" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={16}/></ActionIcon>
        <ActionIcon label="复制代码" hint={status==='success'?'已复制':status==='pending'?'正在复制…':'复制代码'} onClick={() => void copy(value)} disabled={status === 'pending'}>{status==='success'?<Check size={16}/>:<Copy size={16}/>}</ActionIcon>
      </div>
      <pre tabIndex={0} aria-label={wrap ? '代码，自动换行' : '代码，可横向滚动'}>
        <HighlightedCode text={value} language={language} streaming={context.streaming} />
      </pre>
      <span className="code-block-feedback" role="status">
        {status === 'error'
          ? '复制失败，请重试或选中代码手动复制。'
          : status === 'success'
            ? '代码已复制'
            : ''}
      </span>
    </div>
  )
}

const components: Components = {
  a: ({ children, href, title }) => (
    <a
      href={href && /^https?:\/\//i.test(href) ? href : undefined}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) => <code className={className}>{children}</code>,
  pre: CodeBlock,
  table: MarkdownTable
}
const plugins = [remarkGfm]

export const Markdown = memo(function Markdown({
  children,
  identity = '',
  streaming = false
}: {
  children: string
  identity?: string
  streaming?: boolean
}): React.JSX.Element {
  if (children.length > 200 * 1024 || new TextEncoder().encode(children).byteLength > 200 * 1024)
    return (
      <div>
        <p>内容较长，以下以完整纯文本显示。</p>
        <pre className="markdown-plain-fallback">{children}</pre>
      </div>
    )
  return (
    <MarkdownErrorBoundary key={identity} source={children}>
      <MarkdownActionContext.Provider value={{ identity, streaming }}>
        <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>
          {children}
        </ReactMarkdown>
      </MarkdownActionContext.Provider>
    </MarkdownErrorBoundary>
  )
})
