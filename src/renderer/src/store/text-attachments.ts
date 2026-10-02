import { create } from 'zustand'
import { attachmentCommandSchema } from '../../../shared/text-attachments'
import type {
  AttachmentCommand,
  AttachmentReceipt,
  AttachmentScope,
  TextAttachment
} from '../../../shared/text-attachments'
import { usePiStore } from './pi-store'
import { t } from '../../../shared/i18n'

type State = {
  scope: AttachmentScope | null
  files: TextAttachment[]
  staging: boolean
  sending: boolean
  message: string | null
  receipt: AttachmentReceipt | null
  submission: { id: string; scope: AttachmentScope } | null
}
export const useTextAttachments = create<State>(() => ({
  scope: null,
  files: [],
  staging: false,
  sending: false,
  message: null,
  receipt: null,
  submission: null
}))
const key = (scope: AttachmentScope | null): string => JSON.stringify(scope)
usePiStore.subscribe(({ snapshot }) => {
  const scope =
    snapshot.project && snapshot.sessionId
      ? {
          projectPath: snapshot.project.path,
          sessionId: snapshot.sessionId,
          generation: snapshot.generation
        }
      : null
  const previous = useTextAttachments.getState()
  if (key(previous.scope) === key(scope)) return
  useTextAttachments.setState({
    scope,
    files: [],
    staging: false,
    sending: false,
    receipt: null,
    submission: null,
    message:
      previous.files.length || previous.submission
        ? t('会话已切换，未发送的文件已清除；发送状态请在原会话历史中核对。')
        : null
  })
})
export async function stageTextFile(path?: string): Promise<void> {
  const current = useTextAttachments.getState()
  if (!current.scope || current.staging || current.sending || current.submission) return
  useTextAttachments.setState({ staging: true, message: null })
  try {
    const command: AttachmentCommand =
      path === undefined
        ? { type: 'pick', scope: current.scope }
        : { type: 'file', scope: current.scope, path }
    const result = await window.pi.textAttachments(command)
    if (key(useTextAttachments.getState().scope) !== key(current.scope)) return
    if (result.type === 'staged') useTextAttachments.setState({ files: result.files })
    else if (result.type === 'error') useTextAttachments.setState({ message: result.message })
  } catch {
    if (key(useTextAttachments.getState().scope) === key(current.scope))
      useTextAttachments.setState({ message: t('无法添加文件，请重试。') })
  } finally {
    if (key(useTextAttachments.getState().scope) === key(current.scope))
      useTextAttachments.setState({ staging: false })
  }
}
export async function removeTextFile(id: string): Promise<void> {
  const current = useTextAttachments.getState()
  if (!current.scope || current.sending || current.submission || current.staging) return
  useTextAttachments.setState({ staging: true })
  try {
    const result = await window.pi.textAttachments({ type: 'remove', scope: current.scope, id })
    if (key(useTextAttachments.getState().scope) !== key(current.scope)) return
    if (result.type === 'staged')
      useTextAttachments.setState({ files: result.files, message: null })
    else if (result.type === 'error') useTextAttachments.setState({ message: result.message })
  } catch {
    if (key(useTextAttachments.getState().scope) === key(current.scope))
      useTextAttachments.setState({ message: t('无法移除文件，请重试。') })
  } finally {
    if (key(useTextAttachments.getState().scope) === key(current.scope))
      useTextAttachments.setState({ staging: false })
  }
}
export async function sendTextFiles(
  text: string,
  query = false
): Promise<AttachmentReceipt | null> {
  const current = useTextAttachments.getState()
  if (!current.scope || current.sending || current.staging || (!query && current.submission))
    return null
  const submission = current.submission ?? { id: crypto.randomUUID(), scope: current.scope }
  useTextAttachments.setState({ sending: true, submission, message: t('正在等待 Pi 接收确认…') })
  let receipt: AttachmentReceipt = {
    submissionId: submission.id,
    status: 'uncertain',
    code: 'unknown'
  }
  try {
    const command = attachmentCommandSchema.safeParse(
      query
        ? { type: 'query', scope: submission.scope, submissionId: submission.id }
        : {
            type: 'send',
            scope: submission.scope,
            submissionId: submission.id,
            ids: current.files.map((f) => f.id),
            text
          }
    )
    const result = command.success
      ? await window.pi.textAttachments(command.data)
      : {
          type: 'receipt' as const,
          receipt: {
            submissionId: submission.id,
            status: 'rejected' as const,
            code: 'unavailable' as const
          }
        }
    if (result.type === 'receipt') receipt = result.receipt
    else if (result.type === 'error') {
      // No acceptance decision was received. Keep the original submission locked.
      receipt = { ...receipt, code: 'unknown' }
    }
  } catch {
    /* Host loss is unknown, never an automatic retry. */
  }
  if (key(useTextAttachments.getState().scope) !== key(current.scope)) return null
  useTextAttachments.setState({
    sending: false,
    receipt,
    files: receipt.status === 'accepted' ? [] : current.files,
    submission: receipt.status === 'uncertain' ? submission : null,
    message:
      receipt.status === 'accepted'
        ? t('Pi 已接收文本上下文；接收确认不代表已保存或回答成功。')
        : receipt.status === 'rejected'
          ? t('Pi 未接收本次发送，文字和文件已保留，可修改后重试。')
          : t('发送结果未知，文字和文件已保留。请查询原发送结果，勿重复发送。')
  })
  return receipt
}
