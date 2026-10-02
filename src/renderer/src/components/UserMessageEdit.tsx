import { useEffect, useId, useRef, useState } from 'react'
import { closeSessionEdit, sendSessionEdit, useSessionEdit } from '../store/session-edit'
import { usePiStore } from '../store/pi-store'
import { t } from '../../../shared/i18n'

/** Independent draft; never reads or writes the ordinary Composer draft. */
export default function UserMessageEdit(): React.JSX.Element | null {
  const edit = useSessionEdit()
  const snapshot = usePiStore((state) => state.snapshot)
  const id = useId(),
    input = useRef<HTMLTextAreaElement>(null)
  const [reconnecting, setReconnecting] = useState(false)
  useEffect(() => {
    if (edit.phase === 'editing') input.current?.focus()
  }, [edit.phase])
  if (edit.phase === 'closed') return null
  const pending = edit.phase === 'sending',
    unknown = edit.phase === 'uncertain'
  const close = async () => {
    await closeSessionEdit()
    document.querySelector<HTMLButtonElement>(t('button[aria-label="编辑问题"]'))?.focus()
  }
  return (
    <section
      className="user-message-edit"
      aria-label={t('编辑问题面板')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending && !unknown) {
          event.preventDefault()
          void close()
        }
      }}
    >
      <label htmlFor={id}>{t('编辑最近的问题')}</label>
      {edit.phase === 'preparing' ? (
        <p role="status">{t('正在读取原问题…')}</p>
      ) : edit.prepared ? (
        <>
          <textarea
            id={id}
            ref={input}
            rows={3}
            value={edit.text}
            readOnly={edit.phase !== 'editing'}
            aria-describedby={`${id}-hint ${id}-status`}
            onChange={(event) =>
              useSessionEdit.setState({ text: event.target.value, message: null })
            }
          />
          {edit.prepared.attachments.length ? (
            <ul aria-label={t('保留的附件')} className="edit-attachments">
              {edit.prepared.attachments.map((file, i) => (
                <li key={i}>
                  <span>{file.name}</span>
                  <span>
                    {file.kind === 'image' ? file.mimeType : t('{size} 字节', { size: file.size })}{' '}
                    {t('· 保留')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <p id={`${id}-hint`} className="edit-hint">
        {t('发送后从此问题重新开始；已有文件和终端操作不会撤销，工具可能再次执行')}
      </p>
      <p
        id={`${id}-status`}
        role={
          !snapshot.ready ||
          edit.phase === 'stale' ||
          edit.receipt?.status === 'failed-after-mutation'
            ? 'alert'
            : 'status'
        }
        className="edit-status"
      >
        {!snapshot.ready
          ? t(
              '引擎连接已中断，编辑内容已保留。请重新连接引擎后核对当前记录；不能据此判断此前是否已发送。'
            )
          : (edit.message ??
            (edit.phase === 'editing' && snapshot.modelAvailability !== 'available'
              ? t('当前模型不可用，可以查看或取消；选择可用模型后请重新打开编辑确认')
              : null))}
      </p>
      <div className="edit-actions">
        {!snapshot.ready ? (
          <button
            className="primary-button"
            type="button"
            disabled={reconnecting}
            onClick={() => {
              if (reconnecting) return
              setReconnecting(true)
              void window.pi
                .reconnect()
                .then((value) => usePiStore.getState().recover(value))
                .catch(() =>
                  usePiStore.getState().disconnect(t('重新连接失败，两份草稿已保留，请稍后重试'))
                )
                .finally(() => setReconnecting(false))
            }}
          >
            {reconnecting ? t('正在重新连接…') : t('重新连接以核对编辑')}
          </button>
        ) : (
          <>
            {pending || unknown ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  useSessionEdit.setState({
                    message: t('正在停止，等待扩展或工具结束；已有操作不会撤销')
                  })
                  void window.pi.send({ type: 'prompt:abort' }).catch(() => {
                    const current = useSessionEdit.getState()
                    if (current.scope === edit.scope && current.submissionId === edit.submissionId)
                      useSessionEdit.setState({
                        message: t('停止状态尚未确认，请核对引擎连接和当前记录')
                      })
                  })
                }}
              >
                {t('停止')}
              </button>
            ) : (
              <button className="secondary-button" type="button" onClick={() => void close()}>
                {edit.submissionId || edit.phase === 'stale' ? t('关闭并核对') : t('取消')}
              </button>
            )}
            {unknown ? (
              <button className="secondary-button" type="button" onClick={() => void close()}>
                {t('关闭并核对')}
              </button>
            ) : null}
            {unknown ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => void sendSessionEdit(true)}
              >
                {t('查询发送结果')}
              </button>
            ) : edit.phase !== 'finished' && edit.phase !== 'stale' ? (
              <button
                className="primary-button"
                type="button"
                aria-label={t('发送编辑')}
                disabled={
                  edit.phase !== 'editing' ||
                  snapshot.modelAvailability !== 'available' ||
                  Boolean(snapshot.composeBlockReason) ||
                  Boolean(snapshot.edit?.reason) ||
                  (!edit.text.trim() && !edit.prepared?.attachments.length)
                }
                onClick={() => void sendSessionEdit()}
              >
                {pending ? t('正在发送…') : t('发送')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
