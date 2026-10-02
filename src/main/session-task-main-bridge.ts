import { subagentProgress } from './subagent-progress'
import type { AgentSnapshot } from '../shared/contracts'
import type { LiveSessionSummary } from '../shared/session-runtime'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { BackgroundSessionService } from './background-session-service'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import { SessionTaskOrchestrator } from './session-task-orchestrator'
import type { SessionWorkerSupervisor } from './session-worker-supervisor'
import { t } from '../shared/i18n'

/** Main-owned assembly for background Agent session orchestration. */
export class SessionTaskMainBridge {
  private readonly service: BackgroundSessionService
  private readonly orchestrator: SessionTaskOrchestrator
  private readonly broker: SessionTaskCapabilityBroker

  constructor(private readonly workerSupervisor: SessionWorkerSupervisor) {
    this.service = new BackgroundSessionService(workerSupervisor)
    this.orchestrator = new SessionTaskOrchestrator(this.service, {
      onTasksChanged: () => workerSupervisor.summaries()
    })
    this.broker = new SessionTaskCapabilityBroker(this.orchestrator)
  }

  handle(
    workerId: string,
    snapshot: AgentSnapshot | null,
    message: unknown,
    reply: (message: SessionTaskResponse) => void
  ): boolean {
    if (snapshot?.sessionId) {
      this.orchestrator.retireParent(workerId, {
        sessionId: snapshot.sessionId,
        generation: snapshot.generation
      })
    } else {
      this.orchestrator.retireParent(workerId)
    }
    return this.broker.handle(
      workerId,
      snapshot ? { sessionId: snapshot.sessionId, generation: snapshot.generation } : null,
      message,
      reply
    )
  }

  decorateSummaries(summaries: LiveSessionSummary[]): LiveSessionSummary[] {
    const relations = new Map(
      this.orchestrator.relationships().map((relation) => [relation.workerId, relation])
    )
    return summaries.map((summary) => {
      const relation = relations.get(summary.workerId)
      if (!relation) return summary
      const snapshot = this.workerSupervisor.tryGetSnapshot(summary.workerId)
      return {
        ...summary,
        sessionTask: {
          taskId: relation.taskId,
          parentWorkerId: relation.parentWorkerId,
          parentSessionId: relation.parentSessionId,
          parentGeneration: relation.parentGeneration,
          createdAt: relation.createdAt,
          ...(snapshot &&
          snapshot.sessionId === summary.sessionId &&
          snapshot.generation === summary.generation
            ? { progress: subagentProgress(relation.taskId, snapshot, relation.createdAt) }
            : {})
        }
      }
    })
  }

  inspect(
    workerId: string,
    identity: { sessionId: string; generation: number },
    taskId: string
  ): AgentSnapshot {
    const task = this.orchestrator.status({ workerId, ...identity }, taskId)
    const snapshot = this.workerSupervisor.tryGetSnapshot(task.workerId)
    if (
      !snapshot ||
      snapshot.sessionId !== task.sessionId ||
      snapshot.generation !== task.generation
    )
      throw new Error(t('子会话已不可用'))
    return snapshot
  }

  async cancel(
    workerId: string,
    identity: { sessionId: string; generation: number },
    taskId: string
  ): Promise<void> {
    const snapshot = this.workerSupervisor.tryGetSnapshot(workerId)
    if (
      !snapshot ||
      snapshot.sessionId !== identity.sessionId ||
      snapshot.generation !== identity.generation
    )
      throw new Error(t('父会话已改变，请刷新后重试'))
    await this.orchestrator.cancel({ workerId, ...identity }, taskId)
  }

  workerExited(workerId: string): void {
    this.broker.workerExited(workerId)
    this.orchestrator.retireParent(workerId)
  }

  hasPending(workerId: string): boolean {
    return this.broker.hasPending(workerId)
  }
}
