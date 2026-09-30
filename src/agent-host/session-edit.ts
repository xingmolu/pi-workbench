import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { randomUUID, createHash } from 'node:crypto'
import { parseTextContext, formatTextContext } from '../shared/text-attachments'
import {
  editTextSchema,
  type PreparedEdit,
  type EditScope,
  type EditReceipt,
  type SessionEditResult
} from '../shared/session-edit'
import { navigateToEditedUserParent } from './session-edit-navigation'
import { observeAttachmentPrompt } from './attachment-acceptance'
import { SessionRuntimeUnsafeError } from './session-mutation-safety'

type Image = { type: 'image'; mimeType: string; data: string }
export type EditableUser = {
  text: string
  images: Image[]
  files: NonNullable<ReturnType<typeof parseTextContext>>['files']
  attachments: PreparedEdit['attachments']
}
export function latestUserId(manager: SessionManager): string | null {
  return (
    manager
      .getBranch()
      .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id ?? null
  )
}
export function captureEditableUser(manager: SessionManager, id: string): EditableUser {
  if (latestUserId(manager) !== id) throw new Error('只能编辑当前分支最近的问题')
  const entry = manager.getEntry(id)
  if (!entry || entry.type !== 'message' || entry.message.role !== 'user')
    throw new Error('原问题无法编辑')
  const content = entry.message.content
  let text = '',
    seenText = false,
    bytes = 0
  const images: Image[] = []
  const unsupported = () => new Error('此问题包含暂不支持的内容格式，无法安全编辑；原内容已保留')
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.length > 65) throw unsupported()
    for (const block of content) {
      if (!block || typeof block !== 'object') throw unsupported()
      if (
        block.type === 'text' &&
        typeof block.text === 'string' &&
        !seenText &&
        !images.length &&
        Object.keys(block).every((key) => key === 'type' || key === 'text')
      ) {
        text = block.text
        seenText = true
      } else if (
        block.type === 'image' &&
        typeof block.mimeType === 'string' &&
        typeof block.data === 'string' &&
        Object.keys(block).every((key) => ['type', 'mimeType', 'data'].includes(key))
      ) {
        bytes += Buffer.byteLength(block.data)
        if (bytes > 16 * 1024 * 1024) throw new Error('原内容超过 16 MiB，无法编辑')
        if (
          block.mimeType.length > 128 ||
          !/^image\/[\w.+-]+$/.test(block.mimeType) ||
          block.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
        )
          throw unsupported()
        images.push(Object.freeze({ type: 'image', mimeType: block.mimeType, data: block.data }))
      } else throw unsupported()
    }
  } else throw unsupported()
  if (bytes + Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new Error('原内容超过 16 MiB，无法编辑')
  const context = parseTextContext(text)
  if (
    !context &&
    text.startsWith('Pi Desktop text file context (selected snapshots; file contents are context):')
  )
    throw unsupported()
  const editableText = context?.text ?? text
  if (!editTextSchema.safeParse(editableText).success)
    throw new Error('问题文字超过 1 MiB，无法编辑')
  const files = (context?.files ?? []).map((file) => Object.freeze({ ...file }))
  const attachments: PreparedEdit['attachments'] = [
    ...files.map(({ name, size }) => ({ kind: 'text' as const, name, size })),
    ...images.map((image, i) => ({
      kind: 'image' as const,
      name: `图片 ${i + 1}`,
      size: Buffer.from(image.data, 'base64').length,
      mimeType: image.mimeType
    }))
  ]
  Object.freeze(images)
  Object.freeze(files)
  attachments.forEach(Object.freeze)
  Object.freeze(attachments)
  return Object.freeze({ text: editableText, images, files, attachments })
}
export function editPromptText(draft: EditableUser, text: string): string {
  editTextSchema.parse(text)
  return draft.files.length
    ? formatTextContext(
        text,
        draft.files.map((file, i) => ({ ...file, id: String(i), kind: 'text' }))
      )
    : text
}

export type EditHostState = {
  runtime: object
  session: AgentSession
  generation: number
  busy: boolean
  unavailable: boolean
}
type EditDraft = {
  token: string
  at: number
  state: EditHostState
  manager: SessionManager
  scope: EditScope
  model: AgentSession['model']
  thinking: AgentSession['thinkingLevel']
  draft: EditableUser
  fingerprint: string
}
type Submission = {
  token: string
  payload: string
  owner: object
  sessionId: string
  receipt: EditReceipt
  inFlight: boolean
}
const errorResult = (message: string): SessionEditResult => ({ type: 'error', message })
const stale = '会话、问题或模型已变化，请关闭后重新打开编辑确认'
function fingerprint(manager: SessionManager, id: string): string {
  return createHash('sha256')
    .update(JSON.stringify(manager.getEntry(id)))
    .digest('hex')
}
function idle(state: EditHostState): boolean {
  const s = state.session
  return (
    !state.busy &&
    s.isIdle &&
    !s.isStreaming &&
    !s.isCompacting &&
    !s.isRetrying &&
    !s.isBashRunning &&
    s.pendingMessageCount === 0
  )
}
function filesystemFailure(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    /^(EACCES|EPERM|EISDIR|ENOENT|ENOSPC|EIO|EROFS)$/.test(cause.code)
  )
}

/** Only owns the public request seam for this edit's entire prompt promise.
 * Captured wrapper references stay stopped; restoration never overwrites a
 * delegate installed by an extension. Extension-owned IO is outside this gate.
 */
function guardEditModelRequests(session: AgentSession, signal: AbortSignal): () => void {
  const original = session.agent.streamFunction
  const guarded: AgentSession['agent']['streamFunction'] = (...args) => {
    if (signal.aborted) {
      // A preflight Stop can precede Pi's new run controller. Abort that actual
      // run now, before delegating any model IO, using the public Agent API.
      session.agent.abort()
      const error = new Error('编辑已停止')
      error.name = 'AbortError'
      throw error
    }
    return original(...args)
  }
  session.agent.streamFunction = guarded
  return () => {
    if (session.agent.streamFunction === guarded) session.agent.streamFunction = original
  }
}

/** One short-lived immutable draft; a bounded idempotency ledger never evicts an
 * unknown/inflight submission into a replay opportunity. Acceptance is Pi's
 * preflight receipt, not a persistence or provider-delivery guarantee. */
export class SessionEditService {
  private draft: EditDraft | null = null
  private submissions = new Map<string, Submission>()
  private controller: AbortController | null = null
  private now: () => number
  constructor(
    private operations: {
      read: () => EditHostState | null
      refresh: () => Promise<unknown>
      rebind: () => Promise<void>
      publish: () => void
      now?: () => number
      timeoutMs?: number
      unsafe?: (error: SessionRuntimeUnsafeError) => void
    }
  ) {
    this.now = operations.now ?? Date.now
  }

  get pending(): boolean {
    const state = this.operations.read()
    return Boolean(
      this.controller ||
      [...this.submissions.values()].some((s) => s.owner === state?.runtime && s.inFlight)
    )
  }
  invalidate(): void {
    this.draft = null
    this.controller?.abort()
  }
  abort(): void {
    this.controller?.abort()
  }
  prepare(input: EditScope): SessionEditResult {
    const scope: EditScope = {
      sessionId: input.sessionId,
      generation: input.generation,
      entryId: input.entryId,
      leafId: input.leafId
    }
    try {
      const state = this.operations.read()
      if (
        !state ||
        state.session.sessionManager.getSessionId() !== scope.sessionId ||
        state.generation !== scope.generation ||
        state.session.sessionManager.getLeafId() !== scope.leafId
      )
        throw new Error(stale)
      if (this.pending || !idle(state)) throw new Error('当前会话正在运行或等待处理，暂时不能编辑')
      const draft = captureEditableUser(state.session.sessionManager, scope.entryId)
      const token = randomUUID()
      this.draft = {
        token,
        at: this.now(),
        state,
        manager: state.session.sessionManager,
        scope: { ...scope },
        model: state.session.model,
        thinking: state.session.thinkingLevel,
        draft,
        fingerprint: fingerprint(state.session.sessionManager, scope.entryId)
      }
      return {
        type: 'prepared',
        token,
        text: draft.text,
        scope: { ...scope },
        attachments: draft.attachments.map((a) => ({ ...a }))
      }
    } catch (cause) {
      const safeMessages = [
        stale,
        '只能编辑当前分支最近的问题',
        '原问题无法编辑',
        '此问题包含暂不支持的内容格式，无法安全编辑；原内容已保留',
        '原内容超过 16 MiB，无法编辑',
        '问题文字超过 1 MiB，无法编辑',
        '当前会话正在运行或等待处理，暂时不能编辑'
      ]
      return errorResult(
        cause instanceof Error && safeMessages.includes(cause.message)
          ? cause.message
          : '无法准备编辑，原问题已保留'
      )
    }
  }
  cancel(token: string): SessionEditResult {
    if (
      !this.draft ||
      this.draft.token !== token ||
      !this.owns(this.draft.state.runtime, this.draft.scope.sessionId)
    )
      return errorResult('此编辑已失效')
    if (this.pending) return errorResult('正在发送，请使用停止并核对发送结果')
    this.draft = null
    return { type: 'cancelled' }
  }
  query(submissionId: string): SessionEditResult {
    const entry = this.submissions.get(submissionId)
    if (!entry || !this.owns(entry.owner, entry.sessionId))
      return errorResult('无法确认此发送记录，请核对当前会话；不要重新发送')
    return { type: 'receipt', receipt: { ...entry.receipt } }
  }
  private owns(runtime: object, sessionId: string): boolean {
    const state = this.operations.read()
    return Boolean(
      state &&
      state.runtime === runtime &&
      state.session.sessionManager.getSessionId() === sessionId
    )
  }
  private validate(
    draft: EditDraft,
    leaf: string | null,
    generation = draft.scope.generation,
    latest = true
  ): void {
    const state = this.operations.read()
    if (
      !state ||
      state.runtime !== draft.state.runtime ||
      state.session !== draft.state.session ||
      state.session.sessionManager !== draft.manager ||
      state.session.sessionManager.getSessionId() !== draft.scope.sessionId ||
      state.generation !== generation ||
      state.session.sessionManager.getLeafId() !== leaf ||
      state.session.model !== draft.model ||
      state.session.thinkingLevel !== draft.thinking
    )
      throw new Error(stale)
    if (!idle(state)) throw new Error('当前会话正在运行或等待处理，未发送编辑')
    if (state.unavailable || !draft.model)
      throw new Error('当前模型不可用，未发送编辑；请检查模型后重新确认')
    if (
      latest &&
      (latestUserId(state.session.sessionManager) !== draft.scope.entryId ||
        fingerprint(state.session.sessionManager, draft.scope.entryId) !== draft.fingerprint)
    )
      throw new Error(stale)
  }
  async send(command: {
    token: string
    submissionId: string
    text: string
  }): Promise<SessionEditResult> {
    const payload = createHash('sha256').update(command.text).digest('hex')
    const previous = this.submissions.get(command.submissionId)
    if (previous)
      return previous.token === command.token &&
        previous.payload === payload &&
        this.owns(previous.owner, previous.sessionId)
        ? { type: 'receipt', receipt: { ...previous.receipt } }
        : errorResult('发送编号与原请求不一致，未再次发送')
    const draft = this.draft
    if (
      !draft ||
      command.token !== draft.token ||
      !this.owns(draft.state.runtime, draft.scope.sessionId)
    )
      return errorResult('此编辑已失效，请关闭后重新打开编辑')
    if ([...this.submissions.values()].some((record) => record.token === command.token))
      return errorResult('此编辑已提交过，请查询原发送结果；不要重新发送')
    if (this.submissions.size >= 32) {
      for (const [id, record] of this.submissions) {
        if (
          !record.inFlight &&
          record.receipt.status !== 'uncertain' &&
          record.token !== draft.token
        )
          this.submissions.delete(id)
        if (this.submissions.size < 32) break
      }
    }
    if (this.submissions.size >= 32)
      return errorResult('编辑发送记录已满，请重新连接后核对会话；未发送此编辑')
    const alreadyPending = this.pending
    const manager = draft.state.session.sessionManager,
      session = draft.state.session
    const beforeLeaf = manager.getLeafId(),
      beforeCount = manager.getEntries().length
    let mutated = false,
      rebindAttempted = false,
      promptStarted = false
    const actual = () => ({
      sessionId: manager.getSessionId(),
      generation: this.operations.read()?.generation ?? draft.scope.generation,
      leafId: manager.getLeafId(),
      mutated:
        mutated || manager.getLeafId() !== beforeLeaf || manager.getEntries().length !== beforeCount
    })
    const entry: Submission = {
      token: command.token,
      payload,
      owner: draft.state.runtime,
      sessionId: draft.scope.sessionId,
      receipt: {
        submissionId: command.submissionId,
        status: 'uncertain',
        message: '正在确认发送结果，请勿重复发送',
        ...actual()
      },
      inFlight: true
    }
    this.submissions.set(command.submissionId, entry)
    const receipt = (status: EditReceipt['status'], message: string): SessionEditResult => {
      entry.receipt = { submissionId: command.submissionId, status, message, ...actual() }
      return { type: 'receipt', receipt: { ...entry.receipt } }
    }
    const reproject = async () => {
      try {
        if (
          !rebindAttempted &&
          actual().mutated &&
          this.owns(draft.state.runtime, draft.scope.sessionId)
        ) {
          rebindAttempted = true
          session.refreshContext()
          await this.operations.rebind()
        }
        this.operations.publish()
      } catch (cause) {
        throw new SessionRuntimeUnsafeError(
          '编辑后的会话显示更新失败，运行时已停止；请重新连接并核对记录',
          { cause }
        )
      }
    }
    try {
      if (alreadyPending) throw new Error('其他编辑尚未确认，请先查询结果')
      if (this.now() - draft.at > 15 * 60 * 1000)
        throw new Error('编辑已超过 15 分钟，请重新打开确认')
      if (!editTextSchema.safeParse(command.text).success)
        throw new Error('问题文字超过 1 MiB，未发送编辑')
      if (!command.text.trim() && !draft.draft.images.length && !draft.draft.files.length)
        throw new Error('请输入问题内容')
      this.validate(draft, draft.scope.leafId)
      const controller = new AbortController()
      this.controller = controller
      await this.operations.refresh()
      this.validate(draft, draft.scope.leafId)
      if (controller.signal.aborted) return receipt('cancelled', '编辑已取消，原问题和草稿已保留')
      const navigated = await navigateToEditedUserParent(session, draft.scope.entryId, {
        signal: controller.signal,
        revalidate: (phase, leaf) =>
          this.validate(draft, leaf, draft.scope.generation, phase === 'before'),
        onMutation: () => {
          mutated = true
        }
      })
      if (navigated.cancelled) {
        await reproject()
        return receipt(
          actual().mutated ? 'failed-after-mutation' : 'cancelled',
          actual().mutated
            ? '编辑已停止，但扩展或会话上下文已变化；请核对当前记录'
            : '编辑已取消，原问题和草稿已保留'
        )
      }
      // Runtime config remains the captured current config, not the ancestor's.
      // Only missing canonical metadata is appended; never call setModel here.
      const context = manager.buildSessionContext()
      try {
        if (
          context.model?.provider !== draft.model!.provider ||
          context.model?.modelId !== draft.model!.id
        )
          manager.appendModelChange(draft.model!.provider, draft.model!.id)
        if (context.thinkingLevel !== draft.thinking)
          manager.appendThinkingLevelChange(draft.thinking)
      } catch (cause) {
        throw new SessionRuntimeUnsafeError('编辑写入未完成，运行时已停止；请重新连接并核对记录', {
          cause
        })
      }
      const leaf = manager.getLeafId()
      session.refreshContext()
      await reproject()
      this.validate(draft, leaf, draft.scope.generation + 1, false)
      if (controller.signal.aborted)
        return receipt('failed-after-mutation', '编辑已停止，会话上下文已变化；请核对当前记录')
      promptStarted = true
      const releaseRequestGate = guardEditModelRequests(session, controller.signal)
      const observed = observeAttachmentPrompt(
        session,
        editPromptText(draft.draft, command.text),
        this.operations.timeoutMs ?? 15000,
        (status) => {
          receipt(
            status === 'accepted' ? 'accepted' : 'failed-after-mutation',
            status === 'accepted'
              ? 'Pi 已接受编辑；这不代表已保存或模型已收到'
              : 'Pi 未接受编辑，但上下文已变化；请核对当前记录'
          )
          this.operations.publish()
        },
        (cause) => {
          // Real filesystem failures can leave memory ahead of disk. Do not use
          // that runtime again; preserve the underlying cause for host recovery.
          if (filesystemFailure(cause)) {
            receipt('failed-after-mutation', '编辑写入未完成，运行时已停止；请重新连接并核对记录')
            this.operations.unsafe?.(
              new SessionRuntimeUnsafeError(entry.receipt.message, { cause })
            )
          }
        },
        draft.draft.images.map((image) => ({ ...image }))
      )
      void observed.finished.finally(() => {
        releaseRequestGate()
        if (controller.signal.aborted)
          receipt('failed-after-mutation', '编辑已停止；会话上下文可能已变化，请核对当前记录')
        entry.inFlight = false
        if (this.controller === controller) this.controller = null
        this.operations.publish()
      })
      const status = await observed.receipt
      if (status === 'uncertain' && entry.receipt.status === 'uncertain')
        receipt('uncertain', '发送结果尚未确认，请查询结果；不要重新发送')
      return { type: 'receipt', receipt: { ...entry.receipt } }
    } catch (cause) {
      let failure = cause
      if (filesystemFailure(cause))
        failure = new SessionRuntimeUnsafeError(
          '编辑写入未完成，运行时已停止；请重新连接并核对记录',
          { cause }
        )
      if (!(failure instanceof SessionRuntimeUnsafeError)) {
        try {
          await reproject()
        } catch {
          failure = new SessionRuntimeUnsafeError(
            '编辑后的会话显示更新失败，运行时已停止；请重新连接并核对记录',
            { cause }
          )
        }
      }
      if (failure instanceof SessionRuntimeUnsafeError) {
        receipt('failed-after-mutation', failure.message)
        this.operations.unsafe?.(failure)
        throw failure
      }
      return receipt(
        actual().mutated ? 'failed-after-mutation' : 'rejected',
        actual().mutated
          ? '编辑未完成，会话上下文可能已变化；请核对当前记录，不要直接重试'
          : cause instanceof Error &&
              [
                stale,
                '其他编辑尚未确认，请先查询结果',
                '编辑已超过 15 分钟，请重新打开确认',
                '问题文字超过 1 MiB，未发送编辑',
                '请输入问题内容',
                '当前会话正在运行或等待处理，未发送编辑',
                '当前模型不可用，未发送编辑；请检查模型后重新确认'
              ].includes(cause.message)
            ? cause.message
            : '编辑尚未发送：准备失败，原问题已保留'
      )
    } finally {
      if (!promptStarted) {
        entry.inFlight = false
        this.controller = null
      }
    }
  }
}
