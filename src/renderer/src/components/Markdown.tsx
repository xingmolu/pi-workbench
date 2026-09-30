import { streamingMarkdownBlocks } from './streaming-markdown-blocks'
import { useStreamingText } from './use-streaming-text'
import { createContext, memo, useContext, useMemo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { useDesktopSettings } from '../store/desktop-settings'
import remarkGfm from 'remark-gfm'
import { MarkdownTable, MarkdownActionContext } from './MarkdownTable'
import { useMarkdownCopy } from './markdown-copy-action'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { Check, Copy, WrapText } from 'lucide-react'
import { ActionIcon } from './MessageActions'
import { HighlightedCode } from './HighlightedCode'
import { codeBlockText } from './markdown-code'

type PreProps = ComponentProps<Exclude<Components['pre'], string | undefined>>
const CodeWrapContext = createContext<{
  overrides: Map<number, boolean>
  sourceOffset: number
} | null>(null)

export { codeBlockText }

function CodeBlock({ node }: PreProps): React.JSX.Element {
  const value = codeBlockText(node)
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const language = Array.isArray(classes)
    ? String(classes.find((name) => String(name).startsWith('language-')) ?? '').slice(9)
    : ''
  const defaultWrap = useDesktopSettings((state) => state.settings.codeWrap)
  const wrapContext = useContext(CodeWrapContext)
  const sourceOffset = (wrapContext?.sourceOffset ?? 0) + (node?.position?.start.offset ?? 0)
  const [wrapOverride, setWrap] = useState<boolean | null>(
    () => wrapContext?.overrides.get(sourceOffset) ?? null
  )
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
        <ActionIcon
          label="自动换行"
          aria-pressed={wrap}
          onClick={() => {
            wrapContext?.overrides.set(sourceOffset, !wrap)
            setWrap(!wrap)
          }}
        >
          <WrapText size={16} />
        </ActionIcon>
        <ActionIcon
          label="复制代码"
          hint={status === 'success' ? '已复制' : status === 'pending' ? '正在复制…' : '复制代码'}
          onClick={() => void copy(value)}
          disabled={status === 'pending'}
        >
          {status === 'success' ? <Check size={16} /> : <Copy size={16} />}
        </ActionIcon>
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

const MarkdownBody = memo(function MarkdownBody({
  children,
  identity = '',
  streaming = false,
  wrapOverrides,
  sourceOffset = 0
}: {
  children: string
  identity?: string
  streaming?: boolean
  wrapOverrides: Map<number, boolean>
  sourceOffset?: number
}): React.JSX.Element {
  const wrapContext = useMemo(
    () => ({ overrides: wrapOverrides, sourceOffset }),
    [wrapOverrides, sourceOffset]
  )
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
        <CodeWrapContext.Provider value={wrapContext}>
          <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>
            {children}
          </ReactMarkdown>
        </CodeWrapContext.Provider>
      </MarkdownActionContext.Provider>
    </MarkdownErrorBoundary>
  )
})

export const Markdown = memo(function Markdown({
  children,
  identity = '',
  streaming = false
}: {
  children: string
  identity?: string
  streaming?: boolean
}): React.JSX.Element {
  const displayed = useStreamingText(children, identity, streaming)
  // Parsing completed text can remount fences; absolute source positions preserve each user's choice.
  const wrapOverrides = useMemo(() => new Map<number, boolean>(), [identity])
  if (
    !streaming ||
    displayed.length > 200 * 1024 ||
    new TextEncoder().encode(displayed).byteLength > 200 * 1024
  )
    return (
      <MarkdownBody identity={identity} streaming={streaming} wrapOverrides={wrapOverrides}>
        {displayed}
      </MarkdownBody>
    )
  let sourceOffset = 0
  return (
    <>
      {streamingMarkdownBlocks(displayed).map((block, index) => {
        const offset = sourceOffset
        sourceOffset += block.length
        return (
          <MarkdownBody
            key={`${identity}:${index}`}
            identity={`${identity}:${index}`}
            streaming
            wrapOverrides={wrapOverrides}
            sourceOffset={offset}
          >
            {block}
          </MarkdownBody>
        )
      })}
    </>
  )
})
