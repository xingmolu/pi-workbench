import type { ConversationNode } from '../../../shared/contracts'
import { conversationActivity } from '../store/conversation-activity'
import '../assets/conversation-activity.css'

export function ConversationActivity({
  nodes,
  busy,
  approvals
}: {
  nodes: readonly ConversationNode[]
  busy: boolean
  approvals: number
}): React.JSX.Element | null {
  const label = conversationActivity(nodes, busy, approvals)
  return label ? (
    <div className="conversation-activity" role="status" aria-label={label}>
      <span className="activity-orbit" aria-hidden="true" />
      <span>{label}</span>
    </div>
  ) : null
}
