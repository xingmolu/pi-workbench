import type { AgentSnapshot } from '../shared/contracts'
import type { LiveSessionSummary } from '../shared/session-runtime'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { BackgroundSessionService } from './background-session-service'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import { SessionTaskCollector } from './session-task-collection'
import { SessionTaskDelegator } from './session-task-delegation'
import { SessionTaskOrchestrator } from './session-task-orchestrator'
import { SessionTaskSupervisor } from './session-task-supervision'
import type { SessionWorkerSupervisor } from './session-worker-supervisor'

/**
 * Main-owned assembly for SessionTask orchestration.
 *
 * The bridge is intentionally created above SessionWorkerSupervisor and keeps
 * task policy, background-session control and worker IPC authority in Main.
 */
export class SessionTaskMainBridge {
  private readonly service: BackgroundSessionService
  private readonly orchestrator: SessionTaskOrchestrator
  private readonly supervisor: SessionTaskSupervisor
  private readonly collector: SessionTaskCollector
  private readonly delegator: SessionTaskDelegator
  private readonly broker: SessionTaskCapabilityBroker

  constructor(workerSupervisor: SessionWorkerSupervisor) {
    this.service = new BackgroundSessionService(workerSupervisor)
    this.orchestrator = new SessionTaskOrchestrator(this.service, {
      onTasksChanged: () => workerSupervisor.summaries()
    })
    this.supervisor = new SessionTaskSupervisor(this.orchestrator)
    this.collector = new SessionTaskCollector(this.orchestrator)
    this.delegator = new SessionTaskDelegator(this.orchestrator)
    this.broker = new SessionTaskCapabilityBroker({
      orchestrator: this.orchestrator,
      supervisor: this.supervisor,
      collector: this.collector,
      delegator: this.delegator
    })
  }

  handle(
    workerId: string,
    snapshot: AgentSnapshot | null,
    message: unknown,
    reply: (message: SessionTaskResponse) => void
  ): boolean {
    return this.broker.handle(
      workerId,
      snapshot
        ? { sessionId: snapshot.sessionId, generation: snapshot.generation }
        : null,
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
      return {
        ...summary,
        sessionTask: {
          taskId: relation.taskId,
          parentWorkerId: relation.parentWorkerId,
          parentSessionId: relation.parentSessionId,
          parentGeneration: relation.parentGeneration,
          createdAt: relation.createdAt
        }
      }
    })
  }

  /** Remove stale authority if a resident worker switches its native Pi session. */
  workerObserved(workerId: string, snapshot: AgentSnapshot | null): void {
    if (!snapshot?.sessionId) {
      this.orchestrator.retireParent(workerId)
      return
    }
    this.orchestrator.retireParent(workerId, {
      sessionId: snapshot.sessionId,
      generation: snapshot.generation
    })
  }

  workerExited(workerId: string): void {
    this.broker.workerExited(workerId)
    this.orchestrator.retireParent(workerId)
  }

  hasPending(workerId: string): boolean {
    return this.broker.hasPending(workerId)
  }
}
