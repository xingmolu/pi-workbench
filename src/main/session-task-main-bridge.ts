import type { AgentSnapshot } from '../shared/contracts'
import type { LiveSessionSummary } from '../shared/session-runtime'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { BackgroundSessionService } from './background-session-service'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import { SessionTaskOrchestrator } from './session-task-orchestrator'
import type { SessionWorkerSupervisor } from './session-worker-supervisor'

/** Main-owned assembly for background Agent session orchestration. */
export class SessionTaskMainBridge {
  private readonly service: BackgroundSessionService
  private readonly orchestrator: SessionTaskOrchestrator
  private readonly broker: SessionTaskCapabilityBroker

  constructor(workerSupervisor: SessionWorkerSupervisor) {
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
          createdAt: relation.createdAt
        }
      }
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
