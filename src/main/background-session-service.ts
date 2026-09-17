import { createHash } from 'node:crypto'
import type {
  AgentSnapshot,
  HostCommand,
  HostResult,
  PermissionMode
} from '../shared/contracts'
import type { BackgroundSessionAdmission } from './session-worker-pool'

export type BackgroundSessionLifecycleListener = (
  workerId: string,
  snapshot: AgentSnapshot | null
) => void

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
  /**
   * Lifecycle subscription is required by wait(), but remains optional on the
   * structural runtime contract so older test/runtime adapters can migrate
   * without changing ordinary spawn/send/status behavior.
   */
  subscribe?(listener: BackgroundSessionLifecycleListener): () => void
}

export type BackgroundSessionHandle = {
  workerId: string
  sessionId: string
  generation: number
  projectPath: string
}

export type BackgroundSessionStatus = BackgroundSessionHandle & {
  status: AgentSnapshot['status']
  busy: boolean
  queuedCount: number
  approvals: number
}

export type BackgroundSessionWaitOutcome =
  | 'completed'
  | 'error'
  | 'stopped'
  | 'unavailable'
  | 'timeout'

export type BackgroundSessionWaitOptions = {
  timeoutMs: number
  signal?: AbortSignal
}

export type BackgroundSessionWaitResult = {
  outcome: BackgroundSessionWaitOutcome
  status: BackgroundSessionStatus | null
}

export type BackgroundSessionResultOutcome =
  | 'ready'
  | 'pending'
  | 'error'
  | 'stopped'
  | 'unavailable'
  | 'no-result'
  | 'ambiguous'

export type BackgroundSessionResult = {
  outcome: BackgroundSessionResultOutcome
  entryId?: string
  markdown?: string
  truncated?: boolean
  originalLength?: number
}

type ResultCursor = {
  baselineUserEntryId: string | null
  promptDigest: string
}

const MAX_RESULT_CHARS = 32_000

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

function matchesHandle(snapshot: AgentSnapshot, handle: BackgroundSessionHandle): boolean {
  return (
    snapshot.sessionId === handle.sessionId &&
    snapshot.generation === handle.generation &&
    snapshot.project?.path === handle.projectPath
  )
}

function requireHandleSnapshot(
  runtime: BackgroundSessionRuntime,
  handle: BackgroundSessionHandle
): AgentSnapshot {
  const snapshot = requireResidentSnapshot(runtime, handle.workerId)
  if (!matchesHandle(snapshot, handle)) {
    throw new Error('后台会话身份已改变，请重新创建任务')
  }
  return snapshot
}

function statusFromSnapshot(
  handle: BackgroundSessionHandle,
  snapshot: AgentSnapshot
): BackgroundSessionStatus {
  if (!matchesHandle(snapshot, handle)) {
    throw new Error('后台会话身份已改变，请重新创建任务')
  }
  return {
    ...handle,
    status: snapshot.status,
    busy: snapshot.busy,
    queuedCount: snapshot.queuedCount,
    approvals: snapshot.approvals.length
  }
}

function settledOutcome(
  status: BackgroundSessionStatus
): Exclude<BackgroundSessionWaitOutcome, 'unavailable' | 'timeout'> | null {
  if (status.busy || status.queuedCount > 0 || status.approvals > 0) return null
  if (status.status === 'idle') return 'completed'
  if (status.status === 'error') return 'error'
  if (status.status === 'stopped') return 'stopped'
  return null
}

function promptDigest(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex')
}

function latestCanonicalUserEntryId(snapshot: AgentSnapshot): string | null {
  for (let index = snapshot.nodes.length - 1; index >= 0; index -= 1) {
    const node = snapshot.nodes[index]
    if (node.type === 'user' && node.canonicalEntryId) return node.canonicalEntryId
  }
  return null
}

function captureResultCursor(snapshot: AgentSnapshot, prompt: string): ResultCursor {
  return {
    baselineUserEntryId: latestCanonicalUserEntryId(snapshot),
    promptDigest: promptDigest(prompt)
  }
}

function resultFromSnapshot(
  handle: BackgroundSessionHandle,
  snapshot: AgentSnapshot,
  cursor: ResultCursor
): BackgroundSessionResult {
  if (!matchesHandle(snapshot, handle)) return { outcome: 'unavailable' }
  const status = statusFromSnapshot(handle, snapshot)
  const settled = settledOutcome(status)
  if (!settled) return { outcome: 'pending' }
  if (settled === 'error') return { outcome: 'error' }
  if (settled === 'stopped') return { outcome: 'stopped' }

  let baselineIndex = -1
  if (cursor.baselineUserEntryId) {
    baselineIndex = snapshot.nodes.findIndex(
      (node) => node.type === 'user' && node.canonicalEntryId === cursor.baselineUserEntryId
    )
    if (baselineIndex < 0) return { outcome: 'unavailable' }
  }

  let promptIndex = -1
  for (let index = baselineIndex + 1; index < snapshot.nodes.length; index += 1) {
    const node = snapshot.nodes[index]
    if (node.type !== 'user' || !node.canonicalEntryId) continue
    if (promptDigest(node.text) !== cursor.promptDigest) return { outcome: 'ambiguous' }
    promptIndex = index
    break
  }
  if (promptIndex < 0) return { outcome: 'no-result' }

  // A task result is intentionally single-turn. Any later canonical user turn
  // invalidates attribution, even if it repeats the exact same text. This is a
  // conservative alternative to adding a second prompt-submission protocol.
  for (let index = promptIndex + 1; index < snapshot.nodes.length; index += 1) {
    const node = snapshot.nodes[index]
    if (node.type === 'user' && node.canonicalEntryId) return { outcome: 'ambiguous' }
  }

  const completed = snapshot.nodes
    .slice(promptIndex + 1)
    .filter(
      (node): node is Extract<(typeof snapshot.nodes)[number], { type: 'assistant' }> =>
        node.type === 'assistant' && Boolean(node.canonicalEntryId) && !node.streaming
    )
  const entryIds = [...new Set(completed.map((node) => node.canonicalEntryId!))]
  if (entryIds.length === 0) return { outcome: 'no-result' }
  if (entryIds.length !== 1) return { outcome: 'ambiguous' }

  const entryId = entryIds[0]
  const markdown = completed
    .filter((node) => node.canonicalEntryId === entryId)
    .map((node) => node.markdown)
    .join('\n\n')
  if (!markdown) return { outcome: 'no-result' }
  return {
    outcome: 'ready',
    entryId,
    markdown: markdown.slice(0, MAX_RESULT_CHARS),
    originalLength: markdown.length,
    truncated: markdown.length > MAX_RESULT_CHARS
  }
}

function inheritedModel(snapshot: AgentSnapshot): { providerId: string; modelId: string } {
  if (!snapshot.activeProvider || !snapshot.activeModel) {
    throw new Error('父会话没有可继承的模型')
  }
  return { providerId: snapshot.activeProvider, modelId: snapshot.activeModel }
}

/**
 * Narrow service used by Orchestrator/Subagent policy.
 *
 * It translates high-level background-session operations into the stable
 * SessionWorkerSupervisor boundary. Every control operation is scoped to the
 * durable handle captured at spawn time; a worker whose session identity has
 * changed fails closed instead of silently accepting an old task relationship.
 * Result extraction is additionally scoped to a private dispatch cursor, so a
 * later/manual user turn cannot be mistaken for the task's answer.
 * The service deliberately owns no task graph, persistence, worker limits or
 * recursive-spawn policy.
 */
export class BackgroundSessionService {
  private readonly resultCursors = new Map<string, ResultCursor>()

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

    const handle = {
      workerId: admitted.workerId,
      sessionId: identity.sessionId,
      generation: identity.generation,
      projectPath
    }
    const cursor = captureResultCursor(child, text)
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
    this.resultCursors.set(this.handleKey(handle), cursor)
    return handle
  }

  async send(handle: BackgroundSessionHandle, prompt: string): Promise<void> {
    const text = prompt.trim()
    if (!text) throw new Error('后台任务不能为空')
    const snapshot = requireHandleSnapshot(this.runtime, handle)
    if (!snapshot.ready || snapshot.composeBlockReason !== null) {
      throw new Error('后台会话当前不能接收任务')
    }
    const cursor = captureResultCursor(snapshot, text)
    await this.runtime.requestWorker(
      handle.workerId,
      {
        type: 'prompt:send',
        text,
        sessionId: handle.sessionId,
        generation: handle.generation
      },
      { sessionId: handle.sessionId, generation: handle.generation }
    )
    this.resultCursors.set(this.handleKey(handle), cursor)
  }

  async abort(handle: BackgroundSessionHandle): Promise<void> {
    requireHandleSnapshot(this.runtime, handle)
    await this.runtime.requestWorker(
      handle.workerId,
      { type: 'prompt:abort' },
      { sessionId: handle.sessionId, generation: handle.generation }
    )
  }

  status(handle: BackgroundSessionHandle): BackgroundSessionStatus {
    return statusFromSnapshot(handle, requireHandleSnapshot(this.runtime, handle))
  }

  result(handle: BackgroundSessionHandle): BackgroundSessionResult {
    const snapshot = this.runtime.tryGetSnapshot(handle.workerId)
    if (!snapshot || !matchesHandle(snapshot, handle)) return { outcome: 'unavailable' }
    const cursor = this.resultCursors.get(this.handleKey(handle))
    if (!cursor) return { outcome: 'no-result' }
    return resultFromSnapshot(handle, snapshot, cursor)
  }

  /**
   * Wait for the exact durable child to reach a settled terminal state.
   *
   * Subscribe first, then re-read the current snapshot to avoid missing a fast
   * completion between the caller's last status read and listener attachment.
   * The wait never infers transcript/result content; it returns only bounded
   * lifecycle state.
   */
  wait(
    handle: BackgroundSessionHandle,
    options: BackgroundSessionWaitOptions
  ): Promise<BackgroundSessionWaitResult> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      return Promise.reject(new Error('timeoutMs must be a non-negative finite number'))
    }
    const subscribe = this.runtime.subscribe
    if (!subscribe) {
      return Promise.reject(new Error('后台会话运行时不支持生命周期订阅'))
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('等待后台任务已取消'))
    }

    return new Promise<BackgroundSessionWaitResult>((resolve, reject) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = (): void => undefined

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        unsubscribe()
      }
      const finish = (result: BackgroundSessionWaitResult): void => {
        if (finished) return
        finished = true
        cleanup()
        resolve(result)
      }
      const fail = (error: Error): void => {
        if (finished) return
        finished = true
        cleanup()
        reject(error)
      }
      const evaluate = (snapshot: AgentSnapshot | null): void => {
        if (!snapshot || !matchesHandle(snapshot, handle)) {
          finish({ outcome: 'unavailable', status: null })
          return
        }
        const status = statusFromSnapshot(handle, snapshot)
        const outcome = settledOutcome(status)
        if (outcome) finish({ outcome, status })
      }
      const onAbort = (): void => fail(new Error('等待后台任务已取消'))

      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        unsubscribe = subscribe.call(this.runtime, (workerId, snapshot) => {
          if (workerId === handle.workerId) evaluate(snapshot)
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }

      evaluate(this.runtime.tryGetSnapshot(handle.workerId))
      if (finished) return

      timer = setTimeout(() => {
        const snapshot = this.runtime.tryGetSnapshot(handle.workerId)
        if (!snapshot || !matchesHandle(snapshot, handle)) {
          finish({ outcome: 'unavailable', status: null })
          return
        }
        finish({ outcome: 'timeout', status: statusFromSnapshot(handle, snapshot) })
      }, options.timeoutMs)
    })
  }

  private handleKey(handle: BackgroundSessionHandle): string {
    return JSON.stringify([
      handle.workerId,
      handle.sessionId,
      handle.generation,
      handle.projectPath
    ])
  }
}
