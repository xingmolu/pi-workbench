import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { List } from 'lucide-react'
import type { ConversationNode } from '../../../shared/contracts'
import { textContextSummary } from '../../../shared/text-attachments'
import { t } from '../../../shared/i18n'

export default function QuestionNavigation({
  nodes,
  onSelect
}: {
  nodes: ConversationNode[]
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selected = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      selected.current = null
    }
  }, [])
  const questions = nodes.filter((node) => node.type === 'user')
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="session-action"
        aria-label={t('问题导航')}
        title={t('问题导航')}
        disabled={questions.length === 0}
      >
        <List size={14} />
        <span>{t('问题导航')}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="session-popover question-popover"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t('问题导航')}
          onCloseAutoFocus={(event) => {
            if (!mounted.current) {
              event.preventDefault()
              return
            }
            if (selected.current !== null) {
              event.preventDefault()
              const id = selected.current
              selected.current = null
              onSelect(id)
            }
          }}
        >
          <div className="popover-heading">
            <strong>{t('问题导航')}</strong>
            <span>
              {questions.length} {t('条')}
            </span>
          </div>
          <ol>
            {questions.map((node, index) => {
              const summary =
                textContextSummary(node.text).replace(/\s+/g, ' ').trim() || t('空白问题')
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    title={summary}
                    aria-label={`${index + 1}. ${summary}`}
                    onClick={() => {
                      selected.current = node.id
                      setOpen(false)
                    }}
                  >
                    <span>{index + 1}.</span>
                    <span>{summary}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
