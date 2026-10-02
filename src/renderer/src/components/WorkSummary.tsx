import { useState, type ReactNode } from 'react'
import '../assets/conversation-activity.css'
import { useRevealOnOpen } from './use-reveal-on-open'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight } from 'lucide-react'
import { useDesktopSettings } from '../store/desktop-settings'
import { workDigest, workPresentation, type WorkNode } from '../store/conversation-work-groups'
import { t } from '../../../shared/i18n'

export default function WorkSummary({
  nodes,
  running,
  children
}: {
  nodes: readonly WorkNode[]
  running: boolean
  children: ReactNode
}): React.JSX.Element {
  const defaultExpanded = useDesktopSettings((state) => state.settings.workDetails === 'expanded')
  const [expandedOverride, setExpanded] = useState<boolean | null>(null)
  const { label, requiresAttention } = workPresentation(nodes, running)
  const awaitingApproval = nodes.some(
    (node) => node.type === 'tool' && node.status === 'awaiting-approval'
  )
  const digest = running || awaitingApproval ? null : workDigest(nodes)
  const expandedByUser = expandedOverride === true
  const reveal = useRevealOnOpen<HTMLDivElement>(expandedByUser)
  const expanded = awaitingApproval || (expandedOverride ?? (defaultExpanded || requiresAttention))
  return (
    <Collapsible.Root
      className={`work-summary${running && !awaitingApproval ? ' is-running' : ''}`}
      open={expanded}
      onOpenChange={setExpanded}
    >
      <Collapsible.Trigger className="work-summary-trigger">
        {running && !awaitingApproval ? (
          <span className="activity-orbit" aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        <span>{label}</span>
        {digest && digest.parts.length > 0 ? (
          <span className="work-summary-digest">
            {digest.parts.map((part) => (
              <span key={part.label}>
                {part.label} {part.count}
              </span>
            ))}
            {digest.failed > 0 ? (
              <span className="is-failed">
                {digest.failed} {t('项失败')}
              </span>
            ) : null}
          </span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Content
        ref={reveal}
        className="work-summary-content"
        forceMount
        hidden={!expanded}
      >
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
