import { t } from '../shared/i18n'
import type {
  UtilityCompleteCommand,
  UtilityCompletion,
  UtilityModelRef
} from '../shared/utility-model'

export type UtilityRequest = {
  system?: string
  prompt: string
  maxTokens: number
  /** The model of the session the request is about; tried after the small defaults. */
  fallback?: UtilityModelRef
  /**
   * A Pi session worker to run in. It has every model its session can use, including ones Pi
   * extensions register; without it the request runs in Pi's configuration host.
   */
  worker?: string
}

export type UtilityModelServiceOptions = {
  /** Runs the request in the given Pi session worker, or in Pi's configuration host. */
  run(command: UtilityCompleteCommand, worker?: string): Promise<UtilityCompletion>
  /** The model the user chose in Settings; null leaves the choice to the defaults. */
  preferred(): UtilityModelRef | null
  /** Requests running at once, across every caller. */
  maxConcurrent?: number
}

/**
 * Background generations (session titles, commit messages, plugin requests). Each caller has
 * at most one request in flight, so a plugin stuck in a loop cannot queue up spending, and the
 * whole app runs a few at a time.
 */
export class UtilityModelService {
  private readonly owners = new Set<string>()
  private running = 0

  constructor(private readonly options: UtilityModelServiceOptions) {}

  async complete(owner: string, request: UtilityRequest): Promise<UtilityCompletion> {
    if (this.owners.has(owner)) throw new UtilityBusyError(t('上一次生成还没有结束'))
    if (this.running >= (this.options.maxConcurrent ?? 3))
      throw new UtilityBusyError(t('同时进行的生成太多，请稍后再试'))
    this.owners.add(owner)
    this.running++
    try {
      const preferred = this.options.preferred()
      return await this.options.run(
        {
          type: 'utility:complete',
          ...(request.system ? { system: request.system } : {}),
          prompt: request.prompt,
          maxTokens: request.maxTokens,
          preferred: preferred ? [preferred] : [],
          ...(request.fallback ? { fallback: request.fallback } : {})
        },
        request.worker
      )
    } finally {
      this.owners.delete(owner)
      this.running--
    }
  }
}

export class UtilityBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UtilityBusyError'
  }
}
