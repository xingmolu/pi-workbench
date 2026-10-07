import type { AgentSnapshot } from '../shared/contracts'
import type { UtilityModelRef } from '../shared/utility-model'

export type AutoTitleTarget = { cwd: string; path: string; sessionId: string }

export type SessionAutoTitlerOptions = {
  enabled(): boolean
  /** Delegated background work is named by its task, not by the user's first message. */
  isTaskWorker(workerId: string): boolean
  /** A short title for the conversation, already cleaned; empty when nothing usable came back. */
  generate(input: TitleInput): Promise<string>
  rename(target: AutoTitleTarget, title: string): Promise<void>
  onError?(error: unknown): void
}

export type TitleInput = {
  firstMessage: string
  reply: string
  /** For Pi sessions: their model, tried last, and the worker that can reach it. */
  fallback?: UtilityModelRef
  worker?: string
}

type WorkerState =
  /** The worker shows a conversation with no messages yet. */
  | { phase: 'fresh' }
  /** Its first turn has started; the session id is the one that turn belongs to. */
  | { phase: 'running'; sessionId: string | null }

const MAX_MESSAGE_CHARS = 2_000
const MAX_REPLY_CHARS = 1_000

/**
 * Names a conversation after its first turn, the way the user would: from what they asked and
 * how it was answered. Only conversations started in this window are named, never one opened
 * from history, and never one the user renamed (or is renaming) themselves.
 */
export class SessionAutoTitler {
  private readonly workers = new Map<string, WorkerState>()
  private readonly renamed = new Set<string>()
  private readonly inFlight = new Set<string>()

  constructor(private readonly options: SessionAutoTitlerOptions) {}

  /** The user renamed this session; an automatic title must not replace theirs. */
  userRenamed(path: string): void {
    this.renamed.add(path)
  }

  forget(workerId: string): void {
    this.workers.delete(workerId)
  }

  observe(workerId: string, snapshot: AgentSnapshot | null): void {
    if (!snapshot) {
      this.workers.delete(workerId)
      return
    }
    const state = this.workers.get(workerId)
    const firstUser = snapshot.nodes.find((node) => node.type === 'user')
    if (!firstUser) {
      // A new conversation, or the worker moved to one: start over.
      if (state?.phase !== 'fresh') this.workers.set(workerId, { phase: 'fresh' })
      return
    }
    if (!state) return
    if (state.phase === 'fresh') {
      // Opening saved history jumps straight to an idle conversation; only a turn that runs
      // in front of us belongs to a conversation started here.
      if (snapshot.status === 'running' || snapshot.status === 'awaiting-approval')
        this.workers.set(workerId, { phase: 'running', sessionId: snapshot.sessionId })
      else this.workers.delete(workerId)
      return
    }
    if (state.sessionId && snapshot.sessionId && state.sessionId !== snapshot.sessionId) {
      this.workers.delete(workerId)
      return
    }
    if (snapshot.status === 'running' || snapshot.status === 'awaiting-approval') return
    this.workers.delete(workerId)
    // A failed or stopped first turn keeps the title from the first message.
    if (snapshot.status !== 'idle') return
    const path = snapshot.activeSessionPath
    const cwd = snapshot.project?.path
    if (!path || !cwd || !snapshot.sessionId) return
    if (!this.options.enabled() || this.options.isTaskWorker(workerId)) return
    if (this.renamed.has(path) || this.inFlight.has(path)) return
    const reply = snapshot.nodes.find((node) => node.type === 'assistant')
    void this.title(
      { cwd, path, sessionId: snapshot.sessionId },
      {
        firstMessage: firstUser.text.slice(0, MAX_MESSAGE_CHARS),
        reply: reply?.type === 'assistant' ? reply.markdown.slice(0, MAX_REPLY_CHARS) : '',
        ...(snapshot.runtime?.id === 'pi'
          ? {
              worker: workerId,
              ...(snapshot.activeProvider && snapshot.activeModel
                ? {
                    fallback: { providerId: snapshot.activeProvider, modelId: snapshot.activeModel }
                  }
                : {})
            }
          : {})
      }
    )
  }

  private async title(target: AutoTitleTarget, input: TitleInput): Promise<void> {
    if (!input.firstMessage.trim()) return
    this.inFlight.add(target.path)
    try {
      const title = await this.options.generate(input)
      // The user may have renamed it while the title was being written.
      if (!title || this.renamed.has(target.path)) return
      await this.options.rename(target, title)
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.inFlight.delete(target.path)
    }
  }
}

/** The instruction for a session title; the answer is cleaned with `cleanGeneratedLine`. */
export const SESSION_TITLE_SYSTEM = [
  'You name conversations between a user and a coding assistant.',
  'Reply with the title only: at most 8 words, or at most 20 characters for Chinese or Japanese.',
  "Write it in the language of the user's message. Name the task, not the assistant.",
  'No quotes, no trailing punctuation, no prefix such as "Title:".'
].join('\n')

export function sessionTitlePrompt(input: { firstMessage: string; reply: string }): string {
  return [
    '<user_message>',
    input.firstMessage,
    '</user_message>',
    ...(input.reply
      ? ['<assistant_reply_beginning>', input.reply, '</assistant_reply_beginning>']
      : [])
  ].join('\n')
}
