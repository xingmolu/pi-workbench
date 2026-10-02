import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import {
  createCustomEndpointSchema,
  customEndpointSchema,
  isCustomEndpointId,
  type CustomEndpointSaveRequest,
  type CustomEndpointSaveResult,
  type CustomEndpointConfigSnapshot
} from '../shared/custom-endpoints'
import { CustomEndpointConfigError, type CustomEndpointConfigWrite } from './custom-endpoint-config'
import { guardModelMutation, SessionRuntimeUnsafeError } from './session-mutation-safety'
import { t } from '../shared/i18n'

export type {
  CustomEndpointSaveRequest,
  CustomEndpointSaveResult
} from '../shared/custom-endpoints'
export type EndpointSafety = {
  generation: number
  sessionId: string | null
  busy: boolean
  promptPending: boolean
  loginActive: boolean
}
type RuntimeModel = { provider: string; id: string }
type EndpointSession<M> = Parameters<typeof guardModelMutation>[0] & {
  model: M | undefined
  setModel(model: M): Promise<void>
}
export type CustomEndpointDependencies<M extends RuntimeModel> = {
  config: {
    read(): Promise<CustomEndpointConfigSnapshot>
    create(input: CustomEndpointConfigWrite): Promise<CustomEndpointConfigSnapshot>
    update(input: CustomEndpointConfigWrite): Promise<CustomEndpointConfigSnapshot>
  }
  runtime: {
    getProviders(): readonly { id: string }[]
    getRegisteredProviderIds(): readonly string[]
    getRegisteredNativeProvider(id: string): unknown
    isUsingOAuth(id: string): boolean
    getModel(provider: string, model: string): M | undefined
    getError(): string | undefined
    refresh(options: {
      allowNetwork: false
    }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>
    login(id: string, type: 'api_key', interaction: AuthInteraction): Promise<unknown>
  }
  readSafety(): EndpointSafety
  getSession?(): EndpointSession<M> | null
  /** Runtime synchronization block only. False MUST NOT clear selection invalidation.
   * Selection invalidation lasts until explicit model selection/new session binding. */
  setSessionBlocked?(target: EndpointSafety, blocked: boolean): void
  invalidateSelection?(
    target: EndpointSafety,
    reason: 'model-missing' | 'model-config-changed'
  ): void
  rebuildProjections(): Promise<void>
  refreshHistory?(target: EndpointSafety): Promise<void>
}

/** Global config writes are serialized; the host must serialize other login/alias mutations too. */
export class CustomEndpointService<M extends RuntimeModel> {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly dependencies: CustomEndpointDependencies<M>) {}

  save(request: CustomEndpointSaveRequest): Promise<CustomEndpointSaveResult> {
    let captured: EndpointSafety | undefined
    try {
      captured = { ...this.dependencies.readSafety() }
    } catch {
      /* Fail closed below. */
    }
    const operation = this.queue.then(() => this.perform(request, captured))
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async perform(
    request: CustomEndpointSaveRequest,
    captured: EndpointSafety | undefined
  ): Promise<CustomEndpointSaveResult> {
    const d = this.dependencies
    const result: CustomEndpointSaveResult = {
      ok: false,
      providerId: null,
      metadata: 'unchanged',
      credential: 'unchanged',
      runtime: 'failed',
      selection: 'unchanged',
      message: '',
      snapshot: null
    }
    const target = captured
    let stage = 'validation'
    const safe = () => {
      const now = d.readSafety()
      if (
        now.busy ||
        now.promptPending ||
        now.loginActive ||
        (target && (now.generation !== target.generation || now.sessionId !== target.sessionId))
      )
        throw new Error('unsafe')
      return now
    }
    const protectedId = (id: string) =>
      id.startsWith('openai-codex') ||
      !isCustomEndpointId(id) ||
      d.runtime.getRegisteredProviderIds().includes(id) ||
      !!d.runtime.getRegisteredNativeProvider(id) ||
      d.runtime.isUsingOAuth(id)
    const refresh = async () => {
      const refreshed = await d.runtime.refresh({ allowNetwork: false })
      safe()
      if (refreshed.aborted || refreshed.errors.size || d.runtime.getError())
        throw new Error('refresh')
    }
    try {
      if (!target || target.busy || target.promptPending || target.loginActive)
        throw new Error('unsafe')
      safe()
      const parsed = (
        request.id === undefined ? createCustomEndpointSchema : customEndpointSchema
      ).safeParse(request.endpoint)
      if (!parsed.success || typeof request.expectedRevision !== 'string') throw new Error('input')
      const id = request.id ?? `custom-${randomUUID()}`
      if (protectedId(id)) throw new Error('protected')
      result.providerId = id
      result.snapshot = await d.config.read()
      safe()
      if (protectedId(id)) throw new Error('protected')
      if (
        request.id === undefined &&
        (d.runtime.getProviders().some((p) => p.id === id) ||
          result.snapshot.endpoints.some((p) => p.id === id))
      )
        throw new Error('collision')
      const existing = result.snapshot.endpoints.find((p) => p.id === id)
      if (request.id !== undefined && !existing?.editable) throw new Error('protected')
      const { key, ...endpoint } = parsed.data
      stage = 'metadata'
      result.snapshot = await d.config[request.id === undefined ? 'create' : 'update']({
        id,
        expectedRevision: request.expectedRevision,
        endpoint
      })
      result.metadata = 'saved'
      safe()
      stage = 'refresh'
      await refresh()
      if (key !== undefined) {
        stage = 'credential'
        if (protectedId(id)) throw new Error('protected')
        result.credential = 'unknown'
        const encoded = key.replace(/\$/g, '$$$$').replace(/^!/, '$!')
        let unexpectedInteraction = false
        let answered = false
        const rejectInteraction = (): never => {
          unexpectedInteraction = true
          throw new Error(t('端点登录交互不受支持，请检查配置'))
        }
        await d.runtime.login(id, 'api_key', {
          prompt: async (prompt) => {
            safe()
            if (
              unexpectedInteraction ||
              answered ||
              prompt.type !== 'secret' ||
              prompt.message !== 'Enter API key'
            )
              rejectInteraction()
            answered = true
            return encoded
          },
          notify: rejectInteraction
        })
        if (unexpectedInteraction) rejectInteraction()
        result.credential = 'saved'
        safe()
      }
      stage = 'refresh'
      await refresh()
      stage = 'projection'
      await d.rebuildProjections()
      safe()
      const session = d.getSession?.()
      if (session?.model?.provider === id) {
        stage = 'session'
        const model = d.runtime.getModel(id, session.model.id)
        if (!model) {
          d.setSessionBlocked?.(target, true)
          result.selection = 'model-missing'
          d.invalidateSelection?.(target, 'model-missing')
        }
        if (model) {
          await guardModelMutation(session, () => session.setModel(model))
          safe()
          await d.refreshHistory?.(target)
          safe()
          result.selection = 'rebound'
          d.setSessionBlocked?.(target, false)
        }
      } else if (session?.model) {
        const current = session.model
        const catalog = d.runtime.getModel(current.provider, current.id)
        let unchanged = false
        try {
          unchanged = !!catalog && isDeepStrictEqual(current, catalog)
        } catch {
          /* Fail closed without exposing model fields. */
        }
        if (!unchanged) {
          result.selection = catalog ? 'model-config-changed' : 'model-missing'
          safe()
          d.invalidateSelection?.(target, result.selection)
          d.setSessionBlocked?.(target, true)
        }
      }
      result.runtime = 'synchronized'
      result.ok = true
      result.message =
        result.selection === 'model-missing' || result.selection === 'model-config-changed'
          ? t('端点已保存；当前模型已移除或配置已更改，请重新选择模型后发送')
          : t('端点已保存')
    } catch (error) {
      if (error instanceof SessionRuntimeUnsafeError) throw error
      result.message =
        error instanceof CustomEndpointConfigError
          ? error.message
          : result.metadata === 'unchanged'
            ? t('端点未保存，请检查输入、配置版本及当前会话状态后重试')
            : stage === 'credential'
              ? t('端点配置已保存，凭据保存结果不确定；请重新加载并检查登录状态，勿自动重试')
              : t('端点配置已保存，但运行时未同步；请重新加载并检查当前模型后再发送')
      if (target && result.metadata === 'saved') {
        try {
          // Failure blocking is a latch, not a model mutation. An otherwise busy
          // captured session still needs the block once its current work finishes.
          const now = d.readSafety()
          if (
            now.sessionId === target.sessionId &&
            now.generation === target.generation &&
            d.getSession?.()
          )
            d.setSessionBlocked?.(target, true)
        } catch {
          /* A new session must not be mutated. */
        }
      }
      try {
        result.snapshot = await d.config.read()
      } catch {
        result.snapshot = null
      }
      try {
        await d.rebuildProjections()
      } catch {
        /* Preserve the fixed, factual result. */
      }
    }
    return result
  }
}
