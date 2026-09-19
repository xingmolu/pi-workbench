import { createHash, randomUUID } from 'node:crypto'
import {
  computerUseObservationSchema,
  computerUseOperationSchema,
  computerUseResultSchema,
  COMPUTER_USE_LIMITS,
  type ComputerUseElement,
  type ComputerUseObservation,
  type ComputerUseOperation,
  type ComputerUseResult
} from '../shared/computer-use'
import {
  desktopControlGateMessage,
  type AxDump,
  type AxNode
} from '../shared/desktop-control'
import { DesktopControlService } from './desktop-control-service'

export type ComputerUseExecutionScope = {
  ownerId: string
  sessionId: string | null
  generation: number
}

type SemanticState = {
  sessionId: string | null
  generation: number
  stateId: string
  fingerprint: string
  observation: ComputerUseObservation
  elements: Map<string, ComputerUseElement>
}

function fingerprint(dump: AxDump): string {
  return createHash('sha256').update(JSON.stringify(dump)).digest('hex')
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
    throw new Error('目标元素没有可操作的屏幕坐标，请重新 observe 或改用其他目标')
  }
  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2)
  }
}

/**
 * Runtime-neutral host Computer Use coordinator.
 *
 * Agent adapters (Pi / Claude Code / Codex) should expose this contract using their own
 * native tool protocol. OS permissions, stale-state validation and input execution stay here.
 */
export class ComputerUseService {
  private readonly states = new Map<string, SemanticState>()

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
        if (request.mode && request.mode !== 'semantic') {
          throw new Error('visual/fused observation 尚未启用；当前仅支持 semantic')
        }
        return this.observeSemantic(scope, signal)
      case 'search':
        return this.search(scope, request.stateId, request.query)
      case 'inspect':
        return this.inspect(scope, request.stateId, request.ref)
      case 'act':
        if (request.intent === 'type' && !request.text) throw new Error('type 操作需要 text')
        return this.act(scope, request, signal)
    }
  }

  private requireState(scope: ComputerUseExecutionScope, stateId: string): SemanticState {
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

  private async readCurrentSemantic(signal?: AbortSignal): Promise<{
    dump: AxDump
    permission: Awaited<ReturnType<DesktopControlService['accessibility']['dump']>>['permission']
    sessionUnlocked: boolean
  }> {
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

  private async observeSemantic(
    scope: ComputerUseExecutionScope,
    signal?: AbortSignal
  ): Promise<ComputerUseObservation> {
    const current = await this.readCurrentSemantic(signal)
    const { elements, index } = flattenElements(current.dump)
    const observation = computerUseObservationSchema.parse({
      kind: 'observation',
      stateId: randomUUID(),
      mode: 'semantic',
      app: current.dump.app,
      bundleId: current.dump.bundleId,
      truncated: current.dump.truncated,
      elements
    })
    this.states.set(this.scopeKey(scope), {
      sessionId: scope.sessionId,
      generation: scope.generation,
      stateId: observation.stateId,
      fingerprint: fingerprint(current.dump),
      observation,
      elements: index
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

  private async act(
    scope: ComputerUseExecutionScope,
    request: Extract<ComputerUseOperation, { action: 'act' }>,
    signal?: AbortSignal
  ): Promise<ComputerUseResult> {
    const state = this.requireState(scope, request.stateId)
    const element = state.elements.get(request.ref)
    if (!element) throw new Error('Computer Use 元素引用无效，请重新 observe')

    const current = await this.readCurrentSemantic(signal)
    if (fingerprint(current.dump) !== state.fingerprint) {
      this.states.delete(this.scopeKey(scope))
      throw new Error('Computer Use 状态已变化，请重新 observe 后再操作')
    }

    const point = elementCenter(element)
    const screen = this.desktop.capture.readPermission()

    if (request.intent === 'press') {
      const result = await this.desktop.input.click({
        x: point.x,
        y: point.y,
        confirmed: true,
        screen,
        accessibility: current.permission,
        sessionUnlocked: current.sessionUnlocked,
        dump: current.dump,
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
        accessibility: current.permission,
        sessionUnlocked: current.sessionUnlocked,
        dump: current.dump,
        signal
      })
      if (!focused.executed) throw new Error(focused.message ?? '无法聚焦输入目标')
      await this.desktop.input.typeText(request.text!, signal)
    }

    this.states.delete(this.scopeKey(scope))
    const observation = await this.observeSemantic(scope, signal)
    const successor = this.requireState(scope, observation.stateId)
    return computerUseResultSchema.parse({
      kind: 'action',
      previousStateId: request.stateId,
      ref: request.ref,
      action: request.intent,
      delivered: true,
      changed: successor.fingerprint !== state.fingerprint,
      observation,
      message:
        request.intent === 'move'
          ? '已移动指针并刷新界面状态。'
          : successor.fingerprint !== state.fingerprint
            ? '操作已发送，并观察到界面状态变化。'
            : '操作已发送，但未观察到语义结构变化；请根据新状态继续确认。'
    })
  }
}
