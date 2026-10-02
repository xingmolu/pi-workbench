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
  type DesktopControlPermission,
  type DesktopWindowTarget
} from '../shared/desktop-control'
import { DesktopControlService } from './desktop-control-service'
import { TargetCaptureError } from './desktop-control-capture'
import { t } from '../shared/i18n'

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
  target?: DesktopWindowTarget
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
    throw new Error(t('目标元素没有可操作的屏幕坐标，请重新 observe 或改用视觉坐标'))
  }
  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2)
  }
}

function sameRect(left: ComputerUseFrameRect, right: ComputerUseFrameRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function rectsOverlap(left: ComputerUseFrameRect, right: ComputerUseFrameRect): boolean {
  return (
    Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y)
  )
}

class TargetIntegrityError extends Error {}

const SELF_TARGET = t(
  '当前前台窗口是 Pi Desktop 本身，Computer Use 不会读取或操作它。请先用 {"action":"activate","app":"应用名"} 切换到目标应用。'
)

/** The element the model chose is still the same control at the same place. */
function sameElement(left: ComputerUseElement, right: ComputerUseElement | undefined): boolean {
  return (
    right !== undefined &&
    left.role === right.role &&
    left.title === right.title &&
    left.description === right.description &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function targetWindows(dump: AxDump): AxDump {
  const target = dump.target
  return target
    ? { ...dump, windows: dump.windows.filter((window) => window.windowId === target.windowId) }
    : dump
}

function sameTarget(left: DesktopWindowTarget, right: DesktopWindowTarget): boolean {
  return (
    left.pid === right.pid &&
    left.windowId === right.windowId &&
    left.bundleId === right.bundleId &&
    sameRect(left.frame, right.frame)
  )
}

function pointInsideTarget(point: { x: number; y: number }, target: DesktopWindowTarget): boolean {
  return (
    point.x >= target.frame.x &&
    point.y >= target.frame.y &&
    point.x < target.frame.x + target.frame.width &&
    point.y < target.frame.y + target.frame.height
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
  private readonly executions = new Map<string, Set<AbortController>>()

  releaseOwner(ownerId: string): void {
    for (const controller of this.executions.get(ownerId) ?? []) controller.abort()
    this.executions.delete(ownerId)
    this.states.delete(ownerId)
  }

  get stateCount(): number {
    return this.states.size
  }

  constructor(
    private readonly desktop: DesktopControlService,
    /** Pi Desktop's own process: never observed or driven, so the agent cannot approve itself. */
    private readonly options: { selfPid?: number } = {}
  ) {}

  private scopeKey(scope: ComputerUseExecutionScope): string {
    return scope.ownerId
  }

  async execute(
    operation: unknown,
    scope: ComputerUseExecutionScope,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    const controller = new AbortController()
    const active = this.executions.get(scope.ownerId) ?? new Set<AbortController>()
    this.executions.set(scope.ownerId, active)
    active.add(controller)
    const executionSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    try {
      executionSignal.throwIfAborted()
      const request: ComputerUseOperation = computerUseOperationSchema.parse(operation)
      switch (request.action) {
        case 'observe':
          return await this.observe(scope, request.mode ?? 'fused', executionSignal)
        case 'activate':
          return await this.activate(scope, request.app, request.mode ?? 'fused', executionSignal)
        case 'search':
          return this.search(scope, request.stateId, request.query)
        case 'inspect':
          return this.inspect(scope, request.stateId, request.ref)
        case 'act':
          if (request.intent === 'type' && !request.text) throw new Error(t('type 操作需要 text'))
          if (request.intent === 'key' && !request.key) throw new Error(t('key 操作需要 key'))
          if (request.intent !== 'key' && !request.target)
            throw new Error(t('{intent} 操作需要 target', { intent: request.intent }))
          return await this.act(scope, request, executionSignal)
      }
      throw new Error(t('未知 Computer Use 操作'))
    } finally {
      active.delete(controller)
      if (!active.size && this.executions.get(scope.ownerId) === active)
        this.executions.delete(scope.ownerId)
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
      throw new Error(t('Computer Use 状态已过期，请重新 observe'))
    }
    return state
  }

  private async readCurrentSemantic(signal?: AbortSignal): Promise<SemanticContext> {
    const result = await this.desktop.accessibility.dump(signal)
    signal?.throwIfAborted()
    const gate = desktopControlGateMessage({
      platformSupported: result.permission.platformSupported,
      sessionUnlocked: result.sessionUnlocked,
      accessibilityGranted: result.permission.access === 'granted'
    })
    if (gate) throw new Error(gate)
    if (!result.dump) throw new Error(result.message ?? t('无法读取当前桌面语义结构'))
    return {
      dump: result.dump,
      permission: result.permission,
      sessionUnlocked: result.sessionUnlocked
    }
  }

  private async readInputContext(signal?: AbortSignal): Promise<InputContext> {
    const result = await this.desktop.accessibility.dump(signal)
    signal?.throwIfAborted()
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
    semanticTarget?: DesktopWindowTarget,
    signal?: AbortSignal
  ): Promise<{ frame: ComputerUseVisualFrame; target: DesktopWindowTarget }> {
    const unlocked = await this.desktop.accessibility.sessionUnlocked(signal)
    signal?.throwIfAborted()
    if (!unlocked) throw new Error(t('锁屏或锁定会话中拒绝视觉 Computer Use。请解锁后再试。'))
    let target: DesktopWindowTarget
    try {
      target = await this.desktop.accessibility.foregroundWindow(signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw new TargetIntegrityError(t('无法唯一识别当前目标窗口，请重新 observe'), {
        cause: error
      })
    }
    if (semanticTarget && !sameTarget(semanticTarget, target)) {
      throw new TargetIntegrityError(t('辅助功能与截图的目标窗口不一致，请重新 observe'))
    }
    const frame = await this.desktop.capture.captureVisualFrame(target, signal)
    let current: DesktopWindowTarget
    try {
      current = await this.desktop.accessibility.foregroundWindow(signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw new TargetIntegrityError(t('截图后无法确认目标窗口，请重新 observe'), { cause: error })
    }
    if (!sameTarget(target, current)) {
      throw new TargetIntegrityError(t('截图时目标窗口已变化，请重新 observe'))
    }
    return { frame, target }
  }

  private async observe(
    scope: ComputerUseExecutionScope,
    requestedMode: RequestedMode,
    signal?: AbortSignal
  ): Promise<ComputerUseObservation> {
    let semantic: SemanticContext | undefined
    let visual: ComputerUseVisualFrame | undefined
    let target: DesktopWindowTarget | undefined
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
        if (semantic && !semantic.dump.target) {
          throw new TargetIntegrityError(t('辅助功能未能唯一匹配截图窗口，请重新 observe'))
        }
        const captured = await this.readVisual(semantic?.dump.target, signal)
        visual = captured.frame
        target = captured.target
      } catch (error) {
        visualError = error
        if (signal?.aborted) throw error
        if (error instanceof TargetIntegrityError || error instanceof TargetCaptureError)
          throw error
        if (requestedMode === 'visual') throw error
      }
    }

    if (!semantic && !visual) {
      const semanticMessage =
        semanticError instanceof Error ? semanticError.message : t('语义观察不可用')
      const visualMessage = visualError instanceof Error ? visualError.message : t('视觉观察不可用')
      throw new Error(
        t('无法观察桌面：{semanticMessage}；{visualMessage}', { semanticMessage, visualMessage })
      )
    }

    const selfPid = this.options.selfPid
    if (selfPid && (semantic?.dump.target?.pid === selfPid || target?.pid === selfPid))
      throw new Error(SELF_TARGET)

    const matchingWindows = semantic?.dump.target
      ? semantic.dump.windows.filter((window) => window.windowId === semantic.dump.target?.windowId)
      : undefined
    if (matchingWindows && matchingWindows.length !== 1) {
      throw new TargetIntegrityError(t('辅助功能窗口身份不一致，请重新 observe'))
    }
    const flattened = semantic
      ? flattenElements({ ...semantic.dump, windows: matchingWindows ?? semantic.dump.windows })
      : { elements: [] as ComputerUseElement[], index: new Map<string, ComputerUseElement>() }
    const actualMode: RequestedMode = semantic && visual ? 'fused' : visual ? 'visual' : 'semantic'
    const observation = computerUseObservationSchema.parse({
      kind: 'observation',
      stateId: randomUUID(),
      mode: actualMode,
      app: semantic?.dump.app ?? target?.app ?? '',
      bundleId: semantic?.dump.bundleId ?? target?.bundleId ?? '',
      truncated: semantic?.dump.truncated ?? false,
      elements: flattened.elements,
      ...(visual ? { visual } : {})
    })

    signal?.throwIfAborted()
    this.states.set(this.scopeKey(scope), {
      sessionId: scope.sessionId,
      generation: scope.generation,
      stateId: observation.stateId,
      requestedMode,
      ...(semantic ? { semanticFingerprint: fingerprint(semantic.dump) } : {}),
      ...(visual ? { visualFingerprint: visualFingerprint(visual) } : {}),
      observation,
      elements: flattened.index,
      ...(target || semantic?.dump.target ? { target: target ?? semantic?.dump.target } : {})
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
    if (!element) throw new Error(t('Computer Use 元素引用无效，请重新 observe'))
    return computerUseResultSchema.parse({
      kind: 'inspect',
      stateId,
      element
    })
  }

  private async activate(
    scope: ComputerUseExecutionScope,
    app: string,
    mode: RequestedMode,
    signal?: AbortSignal
  ): Promise<ComputerUseObservation> {
    const activated = await this.desktop.accessibility.activateApp(app, signal)
    let failure: unknown
    // Focus moves asynchronously; give the window server a moment before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 250))
      signal?.throwIfAborted()
      try {
        const observation = await this.observe(scope, mode, signal)
        if (!activated.bundleId || observation.bundleId === activated.bundleId) return observation
        failure = new Error(t('前台仍是「{app}」', { app: observation.app }))
      } catch (error) {
        if (signal?.aborted) throw error
        failure = error
      }
    }
    const reason = failure instanceof Error ? failure.message : t('窗口没有出现在前台')
    throw new Error(
      t('已切换到「{app}」，但无法观察它的窗口：{reason}', { app: activated.app, reason })
    )
  }

  /**
   * Approving an action in Pi Desktop brings Pi to the front. The user just approved this
   * exact window, so it is raised again before any check; every identity check still runs.
   */
  private async restoreTarget(target: DesktopWindowTarget, signal?: AbortSignal): Promise<void> {
    try {
      if (sameTarget(target, await this.desktop.accessibility.foregroundWindow(signal))) return
    } catch {
      signal?.throwIfAborted()
    }
    await this.desktop.accessibility.activateTarget(target, signal).catch(() => {
      signal?.throwIfAborted()
    })
  }

  private async validateVisualTarget(
    state: ComputerUseState,
    target: Extract<ComputerUseActionTarget, { kind: 'point' }>,
    signal?: AbortSignal
  ): Promise<{ x: number; y: number }> {
    const visual = state.observation.visual
    if (!visual) throw new Error(t('当前 stateId 没有视觉截图，请重新 visual/fused observe'))
    if (Date.now() - visual.capturedAt > COMPUTER_USE_LIMITS.maxVisualStateAgeMs) {
      throw new Error(t('视觉 Computer Use 状态已过期，请重新 observe'))
    }
    const display = this.desktop.capture
      .readDisplays()
      .find((candidate) => candidate.id === visual.displayId)
    if (
      !display ||
      !rectsOverlap(display.bounds, visual.framePoints) ||
      display.scaleFactor !== visual.scaleFactor
    ) {
      throw new Error(t('显示器布局已变化，请重新 observe'))
    }
    if (!state.target) throw new Error(t('目标窗口身份缺失，请重新 observe'))
    const current = await this.desktop.accessibility.foregroundWindow(signal)
    if (!sameTarget(state.target, current)) {
      throw new Error(t('目标窗口已变化，请重新 observe'))
    }
    return computerUseImagePointToScreenPoint(visual, target)
  }

  private async act(
    scope: ComputerUseExecutionScope,
    request: Extract<ComputerUseOperation, { action: 'act' }>,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    const state = this.requireState(scope, request.stateId)
    if (state.target) await this.restoreTarget(state.target, signal)
    signal?.throwIfAborted()
    if (request.intent === 'key' || !request.target)
      return this.pressKey(scope, state, request, signal)
    let point: { x: number; y: number }
    let inputContext: InputContext

    if (request.target.kind === 'ref') {
      if (!state.target) throw new Error(t('无法确认语义元素所属窗口，请重新 observe'))
      const element = state.elements.get(request.target.ref)
      if (!element || !state.semanticFingerprint) {
        throw new Error(t('当前 stateId 不包含这个语义元素，请重新 semantic/fused observe'))
      }
      const current = await this.readCurrentSemantic(signal)
      // Live apps (chat, mail) change elsewhere all the time; the chosen control must not.
      if (
        fingerprint(current.dump) !== state.semanticFingerprint &&
        !sameElement(element, flattenElements(targetWindows(current.dump)).index.get(element.ref))
      ) {
        this.states.delete(this.scopeKey(scope))
        throw new Error(t('Computer Use 状态已变化，请重新 observe 后再操作'))
      }
      if (!current.dump.target || !sameTarget(state.target, current.dump.target)) {
        throw new Error(t('目标窗口已变化，请重新 observe'))
      }
      point = elementCenter(element)
      inputContext = {
        permission: current.permission,
        sessionUnlocked: current.sessionUnlocked,
        dump: current.dump
      }
    } else {
      point = await this.validateVisualTarget(state, request.target, signal)
      if (state.semanticFingerprint) {
        const current = await this.readCurrentSemantic(signal)
        if (fingerprint(current.dump) !== state.semanticFingerprint) {
          this.states.delete(this.scopeKey(scope))
          throw new Error(t('Computer Use 状态已变化，请重新 observe 后再操作'))
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

    signal?.throwIfAborted()
    if (
      state.observation.visual &&
      Date.now() - state.observation.visual.capturedAt > COMPUTER_USE_LIMITS.maxVisualStateAgeMs
    ) {
      throw new Error(t('视觉 Computer Use 状态已过期，请重新 observe'))
    }
    if (state.target && !pointInsideTarget(point, state.target)) {
      throw new Error(t('操作坐标不在目标窗口内，请重新 observe'))
    }
    if (state.target) {
      const currentTarget = await this.desktop.accessibility.foregroundWindow(signal)
      if (!sameTarget(state.target, currentTarget))
        throw new Error(t('目标窗口已变化，请重新 observe'))
    }
    const expiresAt = state.observation.visual
      ? state.observation.visual.capturedAt + COMPUTER_USE_LIMITS.maxVisualStateAgeMs
      : undefined
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
        expectedTarget: state.target,
        expiresAt,
        signal
      })
      if (!result.executed) throw new Error(result.message ?? t('无法执行桌面点击'))
    } else if (request.intent === 'move') {
      await this.desktop.input.move(point.x, point.y, signal, state.target, expiresAt)
    } else {
      const focused = await this.desktop.input.click({
        x: point.x,
        y: point.y,
        confirmed: true,
        screen,
        accessibility: inputContext.permission,
        sessionUnlocked: inputContext.sessionUnlocked,
        dump: inputContext.dump,
        expectedTarget: state.target,
        expiresAt,
        signal
      })
      if (!focused.executed) throw new Error(focused.message ?? t('无法聚焦输入目标'))
      signal?.throwIfAborted()
      await this.desktop.input.typeText(request.text!, signal, state.target, expiresAt)
    }

    return this.settle(scope, state, request, signal)
  }

  private async pressKey(
    scope: ComputerUseExecutionScope,
    state: ComputerUseState,
    request: Extract<ComputerUseOperation, { action: 'act' }>,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    if (!state.target) throw new Error(t('无法确认按键所属窗口，请重新 observe'))
    if (
      state.observation.visual &&
      Date.now() - state.observation.visual.capturedAt > COMPUTER_USE_LIMITS.maxVisualStateAgeMs
    ) {
      throw new Error(t('视觉 Computer Use 状态已过期，请重新 observe'))
    }
    const current = await this.desktop.accessibility.foregroundWindow(signal)
    if (!sameTarget(state.target, current)) throw new Error(t('目标窗口已变化，请重新 observe'))
    const expiresAt = state.observation.visual
      ? state.observation.visual.capturedAt + COMPUTER_USE_LIMITS.maxVisualStateAgeMs
      : undefined
    await this.desktop.input.pressKey(request.key!, signal, state.target, expiresAt)
    return this.settle(scope, state, request, signal)
  }

  private async settle(
    scope: ComputerUseExecutionScope,
    state: ComputerUseState,
    request: Extract<ComputerUseOperation, { action: 'act' }>,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    signal?.throwIfAborted()
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
      ...(request.target ? { target: request.target } : {}),
      action: request.intent,
      delivered: true,
      changed,
      verification,
      observation,
      message:
        verification === 'semantic-change'
          ? t('操作已发送，并观察到语义界面状态变化。')
          : verification === 'visual-change'
            ? t('操作已发送，并观察到视觉变化；这不单独证明业务动作成功，请依据新截图继续确认。')
            : t('操作已发送，但未观察到可验证变化；请依据新状态继续确认。')
    })
  }
}
