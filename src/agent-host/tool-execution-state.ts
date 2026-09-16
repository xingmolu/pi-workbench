import type { PermissionMode, ToolStatus } from '../shared/contracts'

export type ToolExecutionProjection = {
  status: ToolStatus
  durationMs?: number
}

type ToolExecutionRecord = ToolExecutionProjection & {
  startedAt?: number
}

const APPROVAL_SENSITIVE_TOOLS = new Set(['bash', 'powershell', 'write', 'edit'])

export function requiresToolApproval(mode: PermissionMode, toolName: string): boolean {
  return mode === 'ask' && APPROVAL_SENSITIVE_TOOLS.has(toolName)
}

export class ToolExecutionState {
  private readonly records = new Map<string, ToolExecutionRecord>()

  start(toolCallId: string, approvalRequired: boolean, now: number): ToolExecutionProjection {
    const record: ToolExecutionRecord = approvalRequired
      ? { status: 'queued' }
      : { status: 'running', startedAt: now }
    this.records.set(toolCallId, record)
    return this.project(record)
  }

  approvalPending(toolCallId: string): ToolExecutionProjection {
    return this.set(toolCallId, { status: 'awaiting-approval' })
  }

  waitingForResource(toolCallId: string): ToolExecutionProjection {
    return this.set(toolCallId, { status: 'waiting-resource' })
  }

  executionStarted(toolCallId: string, now: number): ToolExecutionProjection {
    return this.set(toolCallId, { status: 'running', startedAt: now })
  }

  approvalAllowed(toolCallId: string, now: number): ToolExecutionProjection {
    return this.set(toolCallId, { status: 'running', startedAt: now })
  }

  approvalBlocked(toolCallId: string): ToolExecutionProjection {
    return this.set(toolCallId, { status: 'blocked' })
  }

  end(toolCallId: string, isError: boolean, now: number): ToolExecutionProjection {
    const current = this.records.get(toolCallId)
    if (current?.status === 'blocked') return this.project(current)
    const durationMs =
      current?.startedAt === undefined ? undefined : Math.max(0, now - current.startedAt)
    return this.set(toolCallId, {
      status: isError ? 'error' : 'success',
      ...(durationMs !== undefined ? { durationMs } : {})
    })
  }

  get(toolCallId: string): ToolExecutionProjection | undefined {
    const record = this.records.get(toolCallId)
    return record ? this.project(record) : undefined
  }

  clear(): void {
    this.records.clear()
  }

  private set(toolCallId: string, record: ToolExecutionRecord): ToolExecutionProjection {
    this.records.set(toolCallId, record)
    return this.project(record)
  }

  private project(record: ToolExecutionRecord): ToolExecutionProjection {
    return {
      status: record.status,
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {})
    }
  }
}
