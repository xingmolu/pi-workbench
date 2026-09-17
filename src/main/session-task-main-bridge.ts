import type { AgentSnapshot } from '../shared/contracts'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { BackgroundSessionService } from './background-session-service'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import { SessionTaskOrchestrator } from './session-task-orchestrator'
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
  private readonly broker: SessionTaskCapabilityBroker

  constructor(supervisor: SessionWorkerSupervisor) {
    this.service = new BackgroundSessionService(supervisor)
    this.orchestrator = new SessionTaskOrchestrator(this.service)
    this.broker = new SessionTaskCapabilityBroker({ orchestrator: this.orchestrator })
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

  workerExited(workerId: string): void {
    this.broker.workerExited(workerId)
  }

  hasPending(workerId: string): boolean {
    return this.broker.hasPending(workerId)
  }
}
