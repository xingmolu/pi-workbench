import { useEffect, useState, type RefObject } from 'react'
import type { ApprovalRequest } from '../../../shared/contracts'

/** The jump affordance is useful only when a pending request's actions are offscreen. */
export function useOffscreenApproval(
  container: RefObject<HTMLDivElement | null>,
  approvals: readonly ApprovalRequest[],
  scope: string
): ApprovalRequest | null {
  const key = JSON.stringify([scope, approvals.map(({ id, generation }) => [id, generation])])
  const [visibility, setVisibility] = useState<{ key: string; visible: string[] } | null>(null)
  useEffect(() => {
    const root = container.current
    if (!root || approvals.length === 0) return
    const pending = new Set(approvals.map(({ id }) => id))
    const visible = new Set<string>()
    const watched = new Map<Element, string>()
    const publish = () => setVisibility({ key, visible: [...visible] })
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = watched.get(entry.target)
          if (!id) continue
          if (entry.isIntersecting && entry.intersectionRatio >= 0.99) visible.add(id)
          else visible.delete(id)
        }
        publish()
      },
      { root, threshold: [0, 0.99, 1] }
    )
    const scan = () => {
      for (const [element, id] of watched) {
        if (!root.contains(element)) {
          observer.unobserve(element)
          watched.delete(element)
          visible.delete(id)
        }
      }
      for (const element of root.querySelectorAll<HTMLElement>('[data-approval-actions]')) {
        const id = element.dataset.approvalActions!
        if (pending.has(id) && !watched.has(element)) {
          watched.set(element, id)
          observer.observe(element)
        }
      }
    }
    scan()
    // Approvals and their transcript nodes can arrive in separate patches. Ignore unrelated
    // streaming Markdown mutations so a pending approval does not rescan the whole transcript.
    const selector = '[data-approval-actions]'
    const touchesApprovalActions = (node: Node): boolean =>
      node instanceof Element &&
      (node.matches(selector) || Boolean(node.querySelector(selector)))
    const mutations = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(touchesApprovalActions)
        )
      )
        scan()
    })
    mutations.observe(root, { subtree: true, childList: true })
    return () => {
      mutations.disconnect()
      observer.disconnect()
    }
    // The key includes all request identities; content updates do not reset visibility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, key])
  return visibility?.key === key
    ? (approvals.find(({ id }) => !visibility.visible.includes(id)) ?? null)
    : null
}
