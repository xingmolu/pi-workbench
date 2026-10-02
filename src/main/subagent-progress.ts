import type { AgentSnapshot } from '../shared/contracts'
import type { SubagentSummary } from '../shared/subagent'
import { t } from '../shared/i18n'

/** A bounded preview, not a second transcript subscription. */
export function subagentProgress(
  id: string,
  snapshot: AgentSnapshot,
  startedAt: number
): SubagentSummary {
  const userIndex = snapshot.nodes.findLastIndex((node) => node.type === 'user')
  const turn = snapshot.nodes.slice(userIndex + 1)
  const reply = turn.findLast((node) => node.type === 'assistant')
  const tools = turn.filter((node) => node.type === 'tool')
  const latestTool = tools.at(-1)
  const failure = turn.findLast((node) => node.type === 'error')
  const rawOutput =
    snapshot.status === 'error' && failure?.type === 'error'
      ? failure.message
      : reply?.type === 'assistant'
        ? reply.markdown
        : undefined
  const output = rawOutput?.slice(0, 1200)
  const state =
    snapshot.status === 'idle' &&
    !snapshot.busy &&
    reply?.type === 'assistant' &&
    reply.canonicalEntryId
      ? 'success'
      : snapshot.status
  const latest = turn.at(-1)
  const activity = snapshot.approvals.length
    ? t('等待操作确认')
    : state === 'success'
      ? undefined
      : latestTool?.status === 'waiting-resource'
        ? t('等待项目资源 · {title}', { title: latestTool.title })
        : latest?.type === 'tool'
          ? latest.title
          : snapshot.busy
            ? latest?.type === 'assistant'
              ? t('正在生成回复…')
              : t('正在思考…')
            : undefined
  return {
    id,
    revision: snapshot.revision,
    title:
      snapshot.nodes
        .find((node) => node.type === 'user')
        ?.text.split('\n')[0]
        .slice(0, 200) ?? t('子 Agent'),
    state,
    sessionId: snapshot.sessionId ?? undefined,
    generation: snapshot.generation,
    startedAt,
    ...(activity ? { activity: activity.slice(0, 240) } : {}),
    recentTools: tools
      .slice(-3)
      .map((tool) => ({ title: tool.title.slice(0, 240), status: tool.status })),
    ...(output ? { output, truncated: (rawOutput?.length ?? 0) > 1200 } : {}),
    ...(snapshot.activeModel ? { model: snapshot.activeModel.slice(0, 200) } : {}),
    tokens:
      snapshot.metrics.input +
      snapshot.metrics.output +
      snapshot.metrics.cacheRead +
      snapshot.metrics.cacheWrite
  }
}
