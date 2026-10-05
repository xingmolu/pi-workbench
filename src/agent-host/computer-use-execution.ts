import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type {
  ComputerUseObservation,
  ComputerUseOperation,
  ComputerUseResult
} from '../shared/computer-use'
import { t } from '../shared/i18n'

const imageUnavailable = t(
  'MODEL_IMAGE_INPUT_UNAVAILABLE: 当前模型配置未声明图像输入能力。请使用 semantic；若语义内容不足，请停止并请用户切换已确认支持图像的模型或提供界面信息。不要自行打开调试端口、修改目标应用、解包或读取应用源码。'
)
export const COMPUTER_USE_RECOVERY_GUIDELINE =
  'If desktop content is unavailable or incomplete, report the limitation and ask the user to bring the target forward, provide UI details, or select a model configured for image input. Do not infer hidden controls or silently replace UI inspection with shell commands, remote debugging, application unpacking or source/config-file analysis. Those are separate tasks requiring an explicit user request.'

function semanticOnly(observation: ComputerUseObservation): ComputerUseObservation {
  const { visual: _visual, ...rest } = observation
  return { ...rest, mode: 'semantic' }
}

/** A point target is screenshot pixels, so it needs a model that saw the screenshot. */
function usesScreenshotPoints(operation: ComputerUseOperation): boolean {
  if (operation.action !== 'act') return false
  return [operation, ...(operation.steps ?? [])].some(
    (step) => step.target?.kind === 'point' || step.to?.kind === 'point'
  )
}

export async function executeComputerUse(
  operation: ComputerUseOperation,
  modelInput: readonly string[] | undefined,
  call: (operation: ComputerUseOperation, signal?: AbortSignal) => Promise<ComputerUseResult>,
  signal?: AbortSignal,
  onAvailability?: (reason: string | null) => void
): Promise<{ content: (TextContent | ImageContent)[]; details: ComputerUseResult }> {
  const canSeeImages = modelInput?.includes('image') === true
  const diagnostics: string[] = []
  if (!canSeeImages) {
    if (
      (operation.action === 'observe' && operation.mode === 'visual') ||
      usesScreenshotPoints(operation)
    ) {
      onAvailability?.(imageUnavailable)
      throw new Error(imageUnavailable)
    }
    diagnostics.push(imageUnavailable)
    if (operation.action === 'observe' || operation.action === 'activate')
      operation = { ...operation, mode: 'semantic' }
  }
  let result: ComputerUseResult
  try {
    result = await call(operation, signal)
  } catch (error) {
    if (!signal?.aborted)
      onAvailability?.(t('桌面观察或操作失败。请重新 observe；仍不可用时报告限制并等待用户指示。'))
    throw error
  }
  signal?.throwIfAborted()
  // A model may change after a fused observation. Never send retained screenshots
  // (even short image payloads) to a model that cannot consume them.
  if (!canSeeImages) {
    if (result.kind === 'observation') result = semanticOnly(result)
    else if (result.kind === 'action')
      result = { ...result, observation: semanticOnly(result.observation) }
  }
  const observation =
    result.kind === 'observation'
      ? result
      : result.kind === 'action'
        ? result.observation
        : undefined
  if (observation) {
    if (observation.truncated)
      diagnostics.push(
        t('SEMANTIC_TRUNCATED: 语义树达到遍历容量或时间上限，不能据此声称已读取完整界面。')
      )
    // Containers/window chrome alone do not establish that web content was read.
    const chromeRoles = new Set(['AXWindow', 'AXGroup', 'AXScrollArea', 'AXWebArea', 'AXUnknown'])
    const chromeTitles = new Set(['close', 'minimize', 'zoom', t('关闭'), t('最小化'), t('全屏幕')])
    const content = observation.elements.some(
      (e) =>
        !chromeRoles.has(e.role) &&
        !chromeTitles.has(e.title.toLowerCase()) &&
        (e.title || e.value || /TextField|TextArea|CheckBox|PopUpButton/.test(e.role))
    )
    if (!content) {
      diagnostics.push(
        t('SEMANTIC_CONTENT_LIMITED: 未识别到可用的页面内容；这不代表页面为空。') +
          COMPUTER_USE_RECOVERY_GUIDELINE
      )
    }
    onAvailability?.(
      !content && !observation.visual ? t('语义内容不足且没有可供当前模型使用的截图。') : null
    )
  }
  const visual = observation?.visual
  const text = JSON.stringify({ ...result, diagnostics }, (key, value) =>
    key === 'data' ? '[desktop screenshot attached separately]' : value
  )
  return {
    content: [
      { type: 'text', text },
      ...(visual
        ? [{ type: 'image' as const, data: visual.image.data, mimeType: visual.image.mimeType }]
        : [])
    ],
    details: result
  }
}

// Per-agent-turn state. Recovery may re-observe; changing the task to source or
// debugger inspection requires another explicit user turn, not a model fallback.
export class ComputerUseRecoveryFence {
  private reason: string | null = null
  update(reason: string | null): void {
    this.reason = reason
  }
  reset(): void {
    this.reason = null
  }
  check(toolName: string, input: unknown): { block: true; reason: string } | undefined {
    if (!this.reason) return undefined
    if (
      toolName === 'computer' &&
      typeof input === 'object' &&
      input !== null &&
      'action' in input &&
      (input.action === 'observe' || input.action === 'activate')
    )
      return undefined
    return {
      block: true,
      reason:
        'COMPUTER_USE_RECOVERY_REQUIRED: ' +
        this.reason +
        ' Stop and explain the limitation to the user. Do not replace the UI task with other tools. Re-observe or wait for a new user instruction.'
    }
  }
}

/**
 * "Allow this app for the rest of this task": remembers which app each state the agent
 * received belongs to (Main is the authority for that identity), and which apps the user
 * trusted for the current run. Cleared when a run starts or ends.
 */
export class ComputerUseAppGrants {
  private readonly apps = new Map<string, { app: string; bundleId: string }>()
  private readonly granted = new Set<string>()

  record(result: ComputerUseResult): void {
    const observation =
      result.kind === 'observation'
        ? result
        : result.kind === 'action'
          ? result.observation
          : undefined
    if (!observation?.bundleId) return
    this.apps.set(observation.stateId, { app: observation.app, bundleId: observation.bundleId })
    // States are single-use and short-lived; keep only recent ones.
    while (this.apps.size > 64) this.apps.delete(this.apps.keys().next().value!)
  }

  /** The grant an approval for this input may offer, or undefined. */
  offer(input: unknown): { kind: 'computer-app'; app: string; bundleId: string } | undefined {
    const state = this.stateOf(input)
    return state
      ? { kind: 'computer-app', app: state.app || state.bundleId, bundleId: state.bundleId }
      : undefined
  }

  allows(input: unknown): boolean {
    const state = this.stateOf(input)
    return Boolean(state && this.granted.has(state.bundleId))
  }

  allow(bundleId: string): void {
    this.granted.add(bundleId)
  }

  reset(): void {
    this.granted.clear()
    this.apps.clear()
  }

  private stateOf(input: unknown): { app: string; bundleId: string } | undefined {
    if (typeof input !== 'object' || input === null) return undefined
    const { action, stateId } = input as { action?: unknown; stateId?: unknown }
    return action === 'act' && typeof stateId === 'string' ? this.apps.get(stateId) : undefined
  }
}
