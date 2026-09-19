import { createHash, randomUUID } from 'node:crypto'
import {
  computerUseImagePointToScreenPoint,
  computerUseObservationSchema,
  computerUseOperationSchema,
  computerUseResultSchema,
  COMPUTER_USE_LIMITS,
  type ComputerUseActionTarget,
  type ComputerUseElement,
  type ComputerUseFrameRect,
  type ComputerUseObservation,
  type ComputerUseOperation,
  type ComputerUseResult,
  type ComputerUseVisualFrame
} from '../shared/computer-use'
import {
  desktopControlGateMessage,
  type AxDump,
  type AxNode,
  type DesktopControlPermission
} from '../shared/desktop-control'
import { DesktopControlService } from './desktop-control-service'

export type ComputerUseExecutionScope = {
  ownerId: string
  sessionId: string | null
  generation: number
}

type RequestedMode = 'semantic' | 'visual' | 'fused'

type ComputerUseState = {
  sessionId: string | null
  generation: number
  stateId: string
  requestedMode: RequestedMode
  semanticFingerprint?: string
  visualFingerprint?: string
  observation: ComputerUseObservation
  elements: Map<string, ComputerUseElement>
}

type SemanticContext = {
  dump: AxDump
  permission: DesktopControlPermission
  sessionUnlocked: boolean
}

type InputContext = {
  permission: DesktopControlPermission
  sessionUnlocked: boolean
  dump: AxDump | null
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function visualFingerprint(visual: ComputerUseVisualFrame): string {
  return createHash('sha256').update(visual.image.data).digest('hex')
}

function flattenElements(dump: AxDump): {
  elements: ComputerUseElement[]
  index: Map<string, ComputerUseElement>
} {
  const elements: ComputerUseElement[] = []
  const index = new Map<string, ComputerUseElement>()
  let next = 1

  const visit = (node: AxNode, parentRef?: string): void => {
    const ref = `@e${next++}`
    const element: ComputerUseElement = {
      ref,
      ...(parentRef ? { parentRef } : {}),
      role: node.role,
      title: node.title,
      value: node.value,
      description: node.description,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height
    }
    elements.push(element)
    index.set(ref, element)
    for (const child of node.children) visit(child, ref)
  }

  for (const window of dump.windows) visit(window)
  return { elements, index }
}

function elementCenter(element: ComputerUseElement): { x: number; y: number } {
  if (
    element.x === null ||
    element.y === null ||
    element.width === null ||
    element.height === null ||
    element.width <= 0 ||
    element.height <= 0
  ) {
    throw new Error('目标元素没有可操作的屏幕坐标，请重新 observe 或改用视觉坐标')
  }
  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2)
  }
}

function preferredVisualBounds(dump: AxDump): ComputerUseFrameRect | undefined {
  for (const window of dump.windows) {
    if (
      window.x !== null &&
      window.y !== null &&
      window.width !== null &&
      window.height !== null &&
      window.width > 0 &&
      window.height > 0
    ) {
      return {
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height
      }
    }
  }
  return undefined
}

function sameRect(left: ComputerUseFrameRect, right: ComputerUseFrameRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

/**
 * Runtime-neutral host Computer Use coordinator.
 *
 * Agent adapters (Pi / Claude Code / Codex) expose this contract through their native
 * tool protocol. Observation, OS permissions, stale-state validation and input stay here.
 */
export class ComputerUseService {
  private readonly states = new Map<string, ComputerUseState>()

  constructor(private readonly desktop: DesktopControlService) {}

  private scopeKey(scope: ComputerUseExecutionScope): string {
    return scope.ownerId
  }

  async execute(
    operation: unknown,
    scope: ComputerUseExecutionScope,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    if (signal?.aborted) throw new Error('Computer Use 操作已停止')
    const request: ComputerUseOperation = computerUseOperationSchema.parse(operation)
    switch (request.action) {
      case 'observe':
        return this.observe(scope, request.mode ?? 'fused', signal)
      case 'search':
        return this.search(scope, request.stateId, request.query)
      case 'inspect':
        return this.inspect(scope, request.stateId, request.ref)
      case 'act':
        if (request.intent === 'type' && !request.text) throw new Error('type 操作需要 text')
        return this.act(scope, request, signal)
    }
  }

  private requireState(scope: ComputerUseExecutionScope, stateId: string): ComputerUseState {
    const state = this.states.get(this.scopeKey(scope))
    if (
      !state ||
      state.sessionId !== scope.sessionId ||
      state.generation !== scope.generation ||
      state.stateId !== stateId
    ) {
      throw new Error('Computer Use 状态已过期，请重新 observe')
    }
    return state
  }

  private async readCurrentSemantic(signal?: AbortSignal): Promise<SemanticContext> {
    const result = await this.desktop.accessibility.dump(signal)
    const gate = desktopControlGateMessage({
      platformSupported: result.permission.platformSupported,
      sessionUnlocked: result.sessionUnlocked,
      accessibilityGranted: result.permission.access === 'granted'
    })
    if (gate) throw new Error(gate)
    if (!result.dump) throw new Error(result.message ?? '无法读取当前桌面语义结构')
    return {
      dump: result.dump,
      permission: result.permission,
      sessionUnlocked: result.sessionUnlocked
    }
  }

  private async readInputContext(signal?: AbortSignal): Promise<InputContext> {
    const result = await this.desktop.accessibility.dump(signal)
    const gate = desktopControlGateMessage({
      platformSupported: result.permission.platformSupported,
      sessionUnlocked: result.sessionUnlocked,
      accessibilityGranted: result.permission.access === 'granted'
    })
    if (gate) throw new Error(gate)
    return {
      permission: result.permission,
      sessionUnlocked: result.sessionUnlocked,
      dump: result.dump
    }
  }

  private async readVisual(
    preferredBounds: ComputerUseFrameRect | undefined,
    signal?: AbortSignal
  ): Promise<ComputerUseVisualFrame> {
    const unlocked = await this.desktop.accessibility.sessionUnlocked(signal)
    if (!unlocked) throw new Error('锁屏或锁定会话中拒绝视觉 Computer Use。请解锁后再试。')
    return this.desktop.capture.captureVisualFrame(preferredBounds, signal)
  }

  private async observe(
    scope: ComputerUseExecutionScope,
    requestedMode: RequestedMode,
    signal?: AbortSignal
  ): Promise<ComputerUseObservation> {
    let semantic: SemanticContext | undefined
    let visual: ComputerUseVisualFrame | undefined
    let semanticError: unknown
    let visualError: unknown

    if (requestedMode === 'semantic' || requestedMode === 'fused') {
      try {
        semantic = await this.readCurrentSemantic(signal)
      } catch (error) {
        semanticError = error
        if (signal?.aborted) throw error
        if (requestedMode === 'semantic') throw error
      }
    }

    if (requestedMode === 'visual' || requestedMode === 'fused') {
      try {
        visual = await this.readVisual(
          semantic ? preferredVisualBounds(semantic.dump) : undefined,
          signal
        )
      } catch (error) {
        visualError = error
        if (signal?.aborted) throw error
        if (requestedMode === 'visual') throw error
      }
    }

    if (!semantic && !visual) {
      const semanticMessage =
        semanticError instanceof Error ? semanticError.message : '语义观察不可用'
      const visualMessage = visualError instanceof Error ? visualError.message : '视觉观察不可用'
      throw new Error(`无法观察桌面：${semanticMessage}；${visualMessage}`)
    }

    const flattened = semantic
      ? flattenElements(semantic.dump)
      : { elements: [] as ComputerUseElement[], index: new Map<string, ComputerUseElement>() }
    const actualMode: RequestedMode = semantic && visual ? 'fused' : visual ? 'visual' : 'semantic'
    const observation = computerUseObservationSchema.parse({
      kind: 'observation',
      stateId: randomUUID(),
      mode: actualMode,
      app: semantic?.dump.app ?? '',
      bundleId: semantic?.dump.bundleId ?? '',
      truncated: semantic?.dump.truncated ?? false,
      elements: flattened.elements,
      ...(visual ? { visual } : {})
    })

    this.states.set(this.scopeKey(scope), {
      sessionId: scope.sessionId,
      generation: scope.generation,
      stateId: observation.stateId,
      requestedMode,
      ...(semantic ? { semanticFingerprint: fingerprint(semantic.dump) } : {}),
      ...(visual ? { visualFingerprint: visualFingerprint(visual) } : {}),
      observation,
      elements: flattened.index
    })
    return observation
  }

  private search(
    scope: ComputerUseExecutionScope,
    stateId: string,
    query: string
  ): ComputerUseResult {
    const state = this.requireState(scope, stateId)
    const needle = query.trim().toLocaleLowerCase()
    const matches = state.observation.elements
      .filter((element) =>
        [element.role, element.title, element.value, element.description]
          .join('\n')
          .toLocaleLowerCase()
          .includes(needle)
      )
      .slice(0, COMPUTER_USE_LIMITS.maxResults)

    return computerUseResultSchema.parse({
      kind: 'search',
      stateId,
      query,
      matches
    })
  }

  private inspect(
    scope: ComputerUseExecutionScope,
    stateId: string,
    ref: string
  ): ComputerUseResult {
    const state = this.requireState(scope, stateId)
    const element = state.elements.get(ref)
    if (!element) throw new Error('Computer Use 元素引用无效，请重新 observe')
    return computerUseResultSchema.parse({
      kind: 'inspect',
      stateId,
      element
    })
  }

  private validateVisualTarget(
    state: ComputerUseState,
    target: Extract<ComputerUseActionTarget, { kind: 'point' }>
  ): { x: number; y: number } {
    const visual = state.observation.visual
    if (!visual) throw new Error('当前 stateId 没有视觉截图，请重新 visual/fused observe')
    if (Date.now() - visual.capturedAt > COMPUTER_USE_LIMITS.maxVisualStateAgeMs) {
      throw new Error('视觉 Computer Use 状态已过期，请重新 observe')
    }
    const display = this.desktop.capture
      .readDisplays()
      .find((candidate) => candidate.id === visual.displayId)
    if (
      !display ||
      !sameRect(display.bounds, visual.framePoints) ||
      display.scaleFactor !== visual.scaleFactor
    ) {
      throw new Error('显示器布局已变化，请重新 observe')
    }
    return computerUseImagePointToScreenPoint(visual, target)
  }

  private async act(
    scope: ComputerUseExecutionScope,
    request: Extract<ComputerUseOperation, { action: 'act' }>,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    const state = this.requireState(scope, request.stateId)
    let point: { x: number; y: number }
    let inputContext: InputContext

    if (request.target.kind === 'ref') {
      const element = state.elements.get(request.target.ref)
      if (!element || !state.semanticFingerprint) {
        throw new Error('当前 stateId 不包含这个语义元素，请重新 semantic/fused observe')
      }
      const current = await this.readCurrentSemantic(signal)
      if (fingerprint(current.dump) !== state.semanticFingerprint) {
        this.states.delete(this.scopeKey(scope))
        throw new Error('Computer Use 状态已变化，请重新 observe 后再操作')
      }
      point = elementCenter(element)
      inputContext = {
        permission: current.permission,
        sessionUnlocked: current.sessionUnlocked,
        dump: current.dump
      }
    } else {
      point = this.validateVisualTarget(state, request.target)
      if (state.semanticFingerprint) {
        const current = await this.readCurrentSemantic(signal)
        if (fingerprint(current.dump) !== state.semanticFingerprint) {
          this.states.delete(this.scopeKey(scope))
          throw new Error('Computer Use 状态已变化，请重新 observe 后再操作')
        }
        inputContext = {
          permission: current.permission,
          sessionUnlocked: current.sessionUnlocked,
          dump: current.dump
        }
      } else {
        inputContext = await this.readInputContext(signal)
      }
    }

    const screen = this.desktop.capture.readPermission()
    if (request.intent === 'press') {
      const result = await this.desktop.input.click({
        x: point.x,
        y: point.y,
        confirmed: true,
        screen,
        accessibility: inputContext.permission,
        sessionUnlocked: inputContext.sessionUnlocked,
        dump: inputContext.dump,
        signal
      })
      if (!result.executed) throw new Error(result.message ?? '无法执行桌面点击')
    } else if (request.intent === 'move') {
      await this.desktop.input.move(point.x, point.y, signal)
    } else {
      const focused = await this.desktop.input.click({
        x: point.x,
        y: point.y,
        confirmed: true,
        screen,
        accessibility: inputContext.permission,
        sessionUnlocked: inputContext.sessionUnlocked,
        dump: inputContext.dump,
        signal
      })
      if (!focused.executed) throw new Error(focused.message ?? '无法聚焦输入目标')
      await this.desktop.input.typeText(request.text!, signal)
    }

    this.states.delete(this.scopeKey(scope))
    const observation = await this.observe(scope, state.requestedMode, signal)
    const successor = this.requireState(scope, observation.stateId)
    const semanticChanged =
      Boolean(state.semanticFingerprint) &&
      Boolean(successor.semanticFingerprint) &&
      successor.semanticFingerprint !== state.semanticFingerprint
    const visualChanged =
      Boolean(state.visualFingerprint) &&
      Boolean(successor.visualFingerprint) &&
      successor.visualFingerprint !== state.visualFingerprint
    const verification = semanticChanged
      ? 'semantic-change'
      : visualChanged
        ? 'visual-change'
        : 'delivered-only'
    const changed = semanticChanged || visualChanged

    return computerUseResultSchema.parse({
      kind: 'action',
      previousStateId: request.stateId,
      target: request.target,
      action: request.intent,
      delivered: true,
      changed,
      verification,
      observation,
      message:
        verification === 'semantic-change'
          ? '操作已发送，并观察到语义界面状态变化。'
          : verification === 'visual-change'
            ? '操作已发送，并观察到视觉变化；这不单独证明业务动作成功，请依据新截图继续确认。'
            : '操作已发送，但未观察到可验证变化；请依据新状态继续确认。'
    })
  }
}
