import { useState, type ReactNode } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight } from 'lucide-react'
import { useDesktopSettings } from '../store/desktop-settings'
import { workDigest, workPresentation, type WorkNode } from '../store/conversation-work-groups'

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
  const expanded = awaitingApproval || (expandedOverride ?? (defaultExpanded || requiresAttention))
  return (
    <Collapsible.Root
      className={`work-summary${running ? ' is-running' : ''}`}
      open={expanded}
      onOpenChange={setExpanded}
    >
      <Collapsible.Trigger className="work-summary-trigger">
        <ChevronRight size={14} aria-hidden="true" />
        <span>{label}</span>
        {digest && digest.parts.length > 0 ? (
          <span className="work-summary-digest">
            {digest.parts.map((part) => (
              <span key={part.label}>
                {part.label} {part.count}
              </span>
            ))}
            {digest.failed > 0 ? <span className="is-failed">{digest.failed} 项失败</span> : null}
          </span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Content className="work-summary-content" forceMount hidden={!expanded}>
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
