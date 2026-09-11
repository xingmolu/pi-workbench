import { create } from 'zustand'
import type { AgentSnapshot } from '../../../shared/contracts'
import {
  editTextSchema,
  type EditScope,
  type PreparedEdit,
  type EditReceipt
} from '../../../shared/session-edit'
import { usePiStore } from './pi-store'

type EditState = {
  scope: EditScope | null
  prepared: PreparedEdit | null
  text: string
  phase: 'closed' | 'preparing' | 'editing' | 'sending' | 'uncertain' | 'finished' | 'stale'
  submissionId: string | null
  message: string | null
  receipt: EditReceipt | null
  recoveryRequired: boolean
}
const initial: EditState = {
  scope: null,
  prepared: null,
  text: '',
  phase: 'closed',
  submissionId: null,
  message: null,
  receipt: null,
  recoveryRequired: false
}
export const useSessionEdit = create<EditState>(() => ({ ...initial }))
const same = (scope: EditScope | null, snapshot: AgentSnapshot) =>
  Boolean(
    scope &&
    scope.sessionId === snapshot.sessionId &&
    scope.generation === snapshot.generation &&
    scope.leafId === snapshot.edit?.leafId &&
    scope.entryId === snapshot.edit.entryId
  )
usePiStore.subscribe(({ snapshot }) => {
  const state = useSessionEdit.getState()
  if (!state.scope) return
  if (snapshot.sessionId !== state.scope.sessionId) {
    useSessionEdit.setState({ ...initial })
    return
  }
  if (state.submissionId) {
    if (!snapshot.ready && !state.recoveryRequired)
      useSessionEdit.setState({ recoveryRequired: true })
    else if (snapshot.ready && state.recoveryRequired)
      useSessionEdit.setState({
        phase: 'finished',
        recoveryRequired: false,
        message: '已重新连接。编辑草稿已保留，请核对当前历史；此前发送结果无法继续查询'
      })
    return // Own same-session generation rotation must retain the receipt.
  }
  if (!snapshot.ready || !same(state.scope, snapshot))
    useSessionEdit.setState({
      phase: 'stale',
      message: '会话、问题或模型已变化，请关闭后重新打开编辑确认'
    })
})
export async function prepareSessionEdit(snapshot: AgentSnapshot): Promise<void> {
  if (
    !snapshot.sessionId ||
    !snapshot.edit?.entryId ||
    snapshot.edit.reason ||
    useSessionEdit.getState().phase !== 'closed' ||
    usePiStore.getState().forkPending
  )
    return
  const scope: EditScope = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    entryId: snapshot.edit.entryId,
    leafId: snapshot.edit.leafId
  }
  useSessionEdit.setState({ ...initial, scope, phase: 'preparing' })
  try {
    const { result } = await window.pi.send({ type: 'session:edit:prepare', ...scope })
    if (useSessionEdit.getState().scope !== scope || !same(scope, usePiStore.getState().snapshot))
      return
    if (result.type === 'prepared')
      useSessionEdit.setState({ prepared: result, text: result.text, phase: 'editing' })
    else
      useSessionEdit.setState({
        phase: 'stale',
        message: result.type === 'error' ? result.message : '无法准备编辑，原问题已保留'
      })
  } catch {
    if (useSessionEdit.getState().scope === scope)
      useSessionEdit.setState({
        phase: 'stale',
        message: '无法准备编辑，原问题已保留；请关闭后重试'
      })
  }
}
export async function closeSessionEdit(): Promise<void> {
  const state = useSessionEdit.getState()
  const snapshot = usePiStore.getState().snapshot
  const stillCurrent = (): boolean => {
    const current = useSessionEdit.getState()
    const actual = usePiStore.getState().snapshot
    return (
      current.scope === state.scope &&
      current.submissionId === state.submissionId &&
      current.phase === state.phase &&
      current.recoveryRequired === state.recoveryRequired &&
      actual.sessionId === snapshot.sessionId &&
      actual.generation === snapshot.generation &&
      actual.ready === snapshot.ready
    )
  }
  if (state.phase === 'sending') return
  if (state.prepared && (!state.submissionId || state.phase === 'uncertain')) {
    try {
      const { result } = await window.pi.send({
        type: 'session:edit:cancel',
        token: state.prepared.token
      })
      if (!stillCurrent()) return
      if (state.phase === 'uncertain' && result.type !== 'cancelled') {
        useSessionEdit.setState({
          message: result.type === 'error' ? result.message : '执行仍未结束，请停止后再核对'
        })
        return
      }
    } catch {
      if (!stillCurrent()) return
      if (state.phase === 'uncertain') {
        useSessionEdit.setState({ message: '引擎连接中断，请使用重新连接引擎恢复；编辑内容仍保留' })
        return
      }
    }
  }
  if (stillCurrent()) useSessionEdit.setState({ ...initial })
}
export async function sendSessionEdit(query = false): Promise<void> {
  const state = useSessionEdit.getState()
  if (
    !state.prepared ||
    state.phase === 'sending' ||
    (query ? !state.submissionId : state.phase !== 'editing' || state.submissionId !== null)
  )
    return
  if (!query && !editTextSchema.safeParse(state.text).success) {
    useSessionEdit.setState({ message: '问题文字超过 1 MiB，无法发送' })
    return
  }
  const submissionId = state.submissionId ?? crypto.randomUUID()
  useSessionEdit.setState({ phase: 'sending', submissionId, message: '正在等待 Pi 接收确认…' })
  try {
    const { result } = await window.pi.send(
      query
        ? { type: 'session:edit:query', submissionId }
        : { type: 'session:edit:send', token: state.prepared.token, submissionId, text: state.text }
    )
    const current = useSessionEdit.getState()
    if (current.scope !== state.scope || current.submissionId !== submissionId) return
    if (result.type === 'receipt') {
      const unknown = result.receipt.status === 'uncertain'
      useSessionEdit.setState({
        phase: unknown ? 'uncertain' : 'finished',
        receipt: result.receipt,
        message: result.receipt.message
      })
    } else
      useSessionEdit.setState({
        phase: query ? 'uncertain' : 'finished',
        message: result.type === 'error' ? result.message : '发送状态无法确认，请核对当前会话'
      })
  } catch {
    if (useSessionEdit.getState().scope === state.scope)
      useSessionEdit.setState({
        phase: 'uncertain',
        message: '发送结果尚未确认，编辑内容已保留；请查询结果，不要重新发送'
      })
  }
}
