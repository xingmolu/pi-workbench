import type {
  AgentSnapshot,
  HostCommand,
  HostResult,
  PermissionMode
} from '../shared/contracts'
import type { BackgroundSessionAdmission } from './session-worker-pool'

export type BackgroundSessionRuntime = {
  openBackground(
    target: { cwd: string; path?: string },
    model?: { providerId: string; modelId: string }
  ): Promise<BackgroundSessionAdmission>
  requestWorker(
    workerId: string,
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult>
  tryGetSnapshot(workerId: string): AgentSnapshot | null
}

export type BackgroundSessionHandle = {
  workerId: string
  sessionId: string
  generation: number
  projectPath: string
}

export type BackgroundSessionStatus = {
  workerId: string
  sessionId: string
  generation: number
  projectPath: string
  status: AgentSnapshot['status']
  busy: boolean
  queuedCount: number
  approvals: number
}

function requireResidentSnapshot(
  runtime: BackgroundSessionRuntime,
  workerId: string
): AgentSnapshot {
  const snapshot = runtime.tryGetSnapshot(workerId)
  if (!snapshot) throw new Error('后台会话已结束')
  return snapshot
}

function requireIdentity(snapshot: AgentSnapshot): {
  sessionId: string
  generation: number
} {
  if (!snapshot.sessionId) throw new Error('后台会话尚未建立稳定身份')
  return { sessionId: snapshot.sessionId, generation: snapshot.generation }
}

function requireProject(snapshot: AgentSnapshot): string {
  if (!snapshot.project?.path) throw new Error('父会话没有可用工作区')
  return snapshot.project.path
}

function inheritedModel(snapshot: AgentSnapshot): { providerId: string; modelId: string } {
  if (!snapshot.activeProvider || !snapshot.activeModel) {
    throw new Error('父会话没有可继承的模型')
  }
  return { providerId: snapshot.activeProvider, modelId: snapshot.activeModel }
}

/**
 * Narrow service used by future Orchestrator/Subagent policy.
 *
 * It translates high-level background-session operations into the stable
 * SessionWorkerSupervisor boundary. It deliberately owns no task graph,
 * persistence, worker limits or recursive-spawn policy.
 */
export class BackgroundSessionService {
  constructor(private readonly runtime: BackgroundSessionRuntime) {}

  async spawnFromParent(parentWorkerId: string, prompt: string): Promise<BackgroundSessionHandle> {
    const text = prompt.trim()
    if (!text) throw new Error('后台任务不能为空')

    const parent = requireResidentSnapshot(this.runtime, parentWorkerId)
    const projectPath = requireProject(parent)
    const model = inheritedModel(parent)
    const permissionMode: PermissionMode = parent.permissionMode

    const admitted = await this.runtime.openBackground({ cwd: projectPath }, model)
    let child = admitted.snapshot
    let identity = requireIdentity(child)

    if (child.permissionMode !== permissionMode) {
      await this.runtime.requestWorker(
        admitted.workerId,
        { type: 'permission:set', mode: permissionMode },
        identity
      )
      child = requireResidentSnapshot(this.runtime, admitted.workerId)
      identity = requireIdentity(child)
    }

    if (!child.ready || child.composeBlockReason !== null || child.modelAvailability !== 'available') {
      throw new Error('后台会话当前不能接收任务')
    }

    await this.runtime.requestWorker(
      admitted.workerId,
      {
        type: 'prompt:send',
        text,
        sessionId: identity.sessionId,
        generation: identity.generation
      },
      identity
    )

    return {
      workerId: admitted.workerId,
      sessionId: identity.sessionId,
      generation: identity.generation,
      projectPath
    }
  }

  async send(workerId: string, prompt: string): Promise<void> {
    const text = prompt.trim()
    if (!text) throw new Error('后台任务不能为空')
    const snapshot = requireResidentSnapshot(this.runtime, workerId)
    const identity = requireIdentity(snapshot)
    if (!snapshot.ready || snapshot.composeBlockReason !== null) {
      throw new Error('后台会话当前不能接收任务')
    }
    await this.runtime.requestWorker(
      workerId,
      {
        type: 'prompt:send',
        text,
        sessionId: identity.sessionId,
        generation: identity.generation
      },
      identity
    )
  }

  async abort(workerId: string): Promise<void> {
    const snapshot = requireResidentSnapshot(this.runtime, workerId)
    await this.runtime.requestWorker(workerId, { type: 'prompt:abort' }, requireIdentity(snapshot))
  }

  status(workerId: string): BackgroundSessionStatus {
    const snapshot = requireResidentSnapshot(this.runtime, workerId)
    const identity = requireIdentity(snapshot)
    return {
      workerId,
      ...identity,
      projectPath: requireProject(snapshot),
      status: snapshot.status,
      busy: snapshot.busy,
      queuedCount: snapshot.queuedCount,
      approvals: snapshot.approvals.length
    }
  }
}
