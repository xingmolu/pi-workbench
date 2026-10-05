import { createHash, randomUUID } from 'node:crypto'
import {
  computerUseImagePointToScreenPoint,
  computerUseObservationSchema,
  computerUseOperationSchema,
  computerUseResultSchema,
  COMPUTER_USE_LIMITS,
  computerUseStepProblem,
  parseComputerUseKey,
  type ComputerUseActionTarget,
  type ComputerUseElement,
  type ComputerUseFrameRect,
  type ComputerUseObservation,
  type ComputerUseOperation,
  type ComputerUseResult,
  type ComputerUseStep,
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

/** Lets the interface react to one step before the next is resolved. */
const STEP_PAUSE_MS = 120
/** Wheel lines per scroll amount, so "amount: 1" moves a visible distance. */
const SCROLL_LINES_PER_STEP = 3

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
          return await this.activate(
            scope,
            request.app,
            request.window,
            request.mode ?? 'fused',
            executionSignal
          )
        case 'apps':
          return await this.apps(executionSignal)
        case 'windows':
          return await this.windows(request.app, executionSignal)
        case 'search':
          return this.search(scope, request.stateId, request.query)
        case 'inspect':
          return this.inspect(scope, request.stateId, request.ref)
        case 'act': {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { action, stateId, steps: requested, ...single } = request
          const steps: ComputerUseStep[] = requested ?? [
            { ...single, intent: single.intent! } as ComputerUseStep
          ]
          steps.forEach((step, index) => {
            const problem = computerUseStepProblem(step)
            if (problem)
              throw new Error(
                steps.length > 1
                  ? t('第 {index} 步无效：{problem}', { index: index + 1, problem })
                  : problem
              )
          })
          return await this.act(scope, stateId, steps, executionSignal)
        }
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
    window: string | undefined,
    mode: RequestedMode,
    signal?: AbortSignal
  ): Promise<ComputerUseObservation> {
    const activated = window
      ? await this.desktop.accessibility.activateWindow(app, window, signal)
      : await this.desktop.accessibility.activateApp(app, signal)
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
        if (error instanceof Error && error.message === SELF_TARGET) throw error
        failure = error
      }
    }
    const reason = failure instanceof Error ? failure.message : t('窗口没有出现在前台')
    throw new Error(
      t('已切换到「{app}」，但无法观察它的窗口：{reason}', { app: activated.app, reason })
    )
  }

  private async apps(signal?: AbortSignal): Promise<ComputerUseResult> {
    const apps = await this.desktop.accessibility.listApps(signal)
    return computerUseResultSchema.parse({
      kind: 'apps',
      apps: apps
        .filter((app) => !this.options.selfPid || app.pid !== this.options.selfPid)
        .slice(0, COMPUTER_USE_LIMITS.maxApps)
        .map(({ name, bundleId, active, hidden, windows }) => ({
          name,
          bundleId,
          active,
          hidden,
          windows
        }))
    })
  }

  private async windows(app: string, signal?: AbortSignal): Promise<ComputerUseResult> {
    const listed = await this.desktop.accessibility.listWindows(app, signal)
    if (this.options.selfPid && listed.pid === this.options.selfPid) throw new Error(SELF_TARGET)
    return computerUseResultSchema.parse({
      kind: 'windows',
      app: listed.app,
      bundleId: listed.bundleId,
      windows: listed.windows.slice(0, COMPUTER_USE_LIMITS.maxWindows)
    })
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
    stateId: string,
    steps: ComputerUseStep[],
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    const state = this.requireState(scope, stateId)
    if (state.target) await this.restoreTarget(state.target, signal)
    signal?.throwIfAborted()
    for (const [index, step] of steps.entries()) {
      if (index) await new Promise((resolve) => setTimeout(resolve, STEP_PAUSE_MS))
      signal?.throwIfAborted()
      try {
        await this.runStep(scope, state, step, index === 0, signal)
      } catch (error) {
        if (signal?.aborted || steps.length === 1 || !(error instanceof Error)) throw error
        const message = t('第 {index} 步失败（前 {done} 步已执行，请重新 observe）：{reason}', {
          index: index + 1,
          done: index,
          reason: error.message
        })
        if (index) this.states.delete(this.scopeKey(scope))
        throw new Error(message, { cause: error })
      }
    }
    const last = steps[steps.length - 1]!
    return this.settle(
      scope,
      state,
      {
        stateId,
        target: steps.length === 1 ? last.target : undefined,
        intent: last.intent,
        steps: steps.length > 1 ? steps.length : undefined
      },
      signal
    )
  }

  private visualExpiry(state: ComputerUseState): number | undefined {
    const visual = state.observation.visual
    if (!visual) return undefined
    if (Date.now() - visual.capturedAt > COMPUTER_USE_LIMITS.maxVisualStateAgeMs)
      throw new Error(t('视觉 Computer Use 状态已过期，请重新 observe'))
    return visual.capturedAt + COMPUTER_USE_LIMITS.maxVisualStateAgeMs
  }

  /** The approved window is still the one in front; required before any input. */
  private async requireForeground(state: ComputerUseState, signal?: AbortSignal): Promise<void> {
    if (!state.target) throw new Error(t('无法确认操作所属窗口，请重新 observe'))
    const current = await this.desktop.accessibility.foregroundWindow(signal)
    if (!sameTarget(state.target, current)) throw new Error(t('目标窗口已变化，请重新 observe'))
  }

  /**
   * Resolves a target to a screen point inside the approved window. The first step holds
   * the observed state exactly; later steps expect the earlier ones to have changed it, so a
   * visual point is checked against the window rather than the whole interface.
   */
  private async resolvePoint(
    scope: ComputerUseExecutionScope,
    state: ComputerUseState,
    target: ComputerUseActionTarget,
    first: boolean,
    signal?: AbortSignal
  ): Promise<{ point: { x: number; y: number }; context: InputContext }> {
    let point: { x: number; y: number }
    let context: InputContext
    if (target.kind === 'ref') {
      if (!state.target) throw new Error(t('无法确认语义元素所属窗口，请重新 observe'))
      const element = state.elements.get(target.ref)
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
      context = {
        permission: current.permission,
        sessionUnlocked: current.sessionUnlocked,
        dump: current.dump
      }
    } else {
      point = await this.validateVisualTarget(state, target, signal)
      if (state.semanticFingerprint && first) {
        const current = await this.readCurrentSemantic(signal)
        if (fingerprint(current.dump) !== state.semanticFingerprint) {
          this.states.delete(this.scopeKey(scope))
          throw new Error(t('Computer Use 状态已变化，请重新 observe 后再操作'))
        }
        context = {
          permission: current.permission,
          sessionUnlocked: current.sessionUnlocked,
          dump: current.dump
        }
      } else {
        context = await this.readInputContext(signal)
      }
    }
    signal?.throwIfAborted()
    this.visualExpiry(state)
    if (state.target && !pointInsideTarget(point, state.target)) {
      throw new Error(t('操作坐标不在目标窗口内，请重新 observe'))
    }
    if (state.target) await this.requireForeground(state, signal)
    return { point, context }
  }

  private async clickAt(
    state: ComputerUseState,
    point: { x: number; y: number },
    context: InputContext,
    signal?: AbortSignal,
    button: 'left' | 'right' = 'left'
  ): Promise<void> {
    const result = await this.desktop.input.click({
      x: point.x,
      y: point.y,
      button,
      confirmed: true,
      screen: this.desktop.capture.readPermission(),
      accessibility: context.permission,
      sessionUnlocked: context.sessionUnlocked,
      dump: context.dump,
      expectedTarget: state.target,
      expiresAt: this.visualExpiry(state),
      signal
    })
    if (!result.executed) throw new Error(result.message ?? t('无法执行桌面点击'))
  }

  private async runStep(
    scope: ComputerUseExecutionScope,
    state: ComputerUseState,
    step: ComputerUseStep,
    first: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    const input = this.desktop.input
    const resolve = (
      target: ComputerUseActionTarget
    ): Promise<{ point: { x: number; y: number }; context: InputContext }> =>
      this.resolvePoint(scope, state, target, first, signal)
    switch (step.intent) {
      case 'press': {
        const { point, context } = await resolve(step.target!)
        await this.clickAt(state, point, context, signal)
        return
      }
      case 'move': {
        const { point } = await resolve(step.target!)
        await input.move(point.x, point.y, signal, state.target, this.visualExpiry(state))
        return
      }
      case 'type':
      case 'paste': {
        if (step.target) {
          const { point, context } = await resolve(step.target)
          await this.clickAt(state, point, context, signal)
          signal?.throwIfAborted()
        } else {
          await this.requireForeground(state, signal)
        }
        const expiresAt = this.visualExpiry(state)
        if (step.intent === 'type')
          await input.typeText(step.text!, signal, state.target, expiresAt)
        else await input.paste(step.text!, signal, state.target, expiresAt)
        return
      }
      case 'key': {
        const chord = parseComputerUseKey(step.key!)
        if (!chord) throw new Error(t('不支持的按键'))
        await this.requireForeground(state, signal)
        await input.pressKey(
          chord.key,
          signal,
          state.target,
          this.visualExpiry(state),
          chord.modifiers
        )
        return
      }
      case 'scroll': {
        let point: { x: number; y: number }
        if (step.target) point = (await resolve(step.target)).point
        else {
          await this.requireForeground(state, signal)
          const frame = state.target!.frame
          point = {
            x: Math.round(frame.x + frame.width / 2),
            y: Math.round(frame.y + frame.height / 2)
          }
        }
        const lines = (step.amount ?? 3) * SCROLL_LINES_PER_STEP
        const vertical = step.direction === 'up' ? lines : step.direction === 'down' ? -lines : 0
        const horizontal =
          step.direction === 'left' ? lines : step.direction === 'right' ? -lines : 0
        await input.scroll(
          { ...point, deltaX: horizontal, deltaY: vertical },
          signal,
          state.target,
          this.visualExpiry(state)
        )
        return
      }
      case 'drag': {
        const from = (await resolve(step.target!)).point
        const to = (await resolve(step.to!)).point
        await input.drag(
          { x: from.x, y: from.y, toX: to.x, toY: to.y },
          signal,
          state.target,
          this.visualExpiry(state)
        )
        return
      }
      case 'set_value': {
        const { point } = await resolve(step.target!)
        await input.setValue({ ...point, value: step.value! }, signal, state.target)
        return
      }
      case 'secondary': {
        const { point } = await resolve(step.target!)
        await input.secondary(
          { ...point, name: step.name! },
          signal,
          state.target,
          this.visualExpiry(state)
        )
        return
      }
    }
  }

  private async settle(
    scope: ComputerUseExecutionScope,
    state: ComputerUseState,
    request: {
      stateId: string
      target?: ComputerUseActionTarget
      intent: ComputerUseStep['intent']
      steps?: number
    },
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
      ...(request.steps ? { steps: request.steps } : {}),
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
