import { useState, type ReactNode } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight } from 'lucide-react'
import { useDesktopSettings } from '../store/desktop-settings'
import { workPresentation, type WorkNode } from '../store/conversation-work-groups'

export default function WorkSummary({
  nodes,
  running,
  children
}: {
  nodes: readonly WorkNode[]
  running: boolean
  children: ReactNode
}): React.JSX.Element {
  const defaultExpanded = useDesktopSettings(state => state.settings.workDetails === 'expanded')
  const [expandedOverride, setExpanded] = useState<boolean | null>(null)
  const expanded = expandedOverride ?? defaultExpanded
  const { label, requiresAttention } = workPresentation(nodes, running)
  return (
    <Collapsible.Root
      className="work-summary"
      open={expanded || requiresAttention}
      onOpenChange={setExpanded}
    >
      <Collapsible.Trigger className="work-summary-trigger">
        <ChevronRight size={14} aria-hidden="true" />
        <span>{label}</span>
      </Collapsible.Trigger>
      <Collapsible.Content
        className="work-summary-content"
        forceMount
        hidden={!expanded && !requiresAttention}
      >
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
