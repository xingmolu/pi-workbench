import { streamingMarkdownBlocks } from '../components/streaming-markdown-blocks'
import { useStreamingText } from '../components/use-streaming-text'
import { memo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { HighlightedCode } from '../components/HighlightedCode'
import { codeBlockText } from '../components/markdown-code'
import { copyText } from './copy'

type PreProps = ComponentProps<Exclude<Components['pre'], string | undefined>>

function CodeBlock({ node, streaming }: PreProps & { streaming: boolean }): React.JSX.Element {
  const value = codeBlockText(node)
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const language = Array.isArray(classes)
    ? String(classes.find((name) => String(name).startsWith('language-')) ?? '').slice(9)
    : ''
  const [copied, setCopied] = useState(false)
  return (
    <div className="m-code">
      <div className="m-code-bar">
        <span>{language || '代码'}</span>
        <button
          type="button"
          aria-label="复制代码"
          onClick={() =>
            void copyText(value).then((ok) => {
              setCopied(ok)
              if (ok) setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>
        <HighlightedCode text={value} language={language} streaming={streaming} />
      </pre>
    </div>
  )
}

/** Markdown for the phone: GFM, highlighted code with copy, links that open outside. */
const MobileMarkdownBody = memo(function MobileMarkdownBody({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  return (
    <div className="m-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: (props) => <CodeBlock {...props} streaming={streaming} />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="m-table">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})


export const MobileMarkdown = memo(function MobileMarkdown({ text, streaming = false }: {
  text: string; streaming?: boolean
}): React.JSX.Element {
  const displayed = useStreamingText(text, 'mobile-message', streaming)
  if (!streaming) return <MobileMarkdownBody text={displayed} />
  return <>{streamingMarkdownBlocks(displayed).map((block, index) =>
    <MobileMarkdownBody key={index} text={block} streaming />
  )}</>
})
