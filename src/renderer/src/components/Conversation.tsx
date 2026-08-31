export default function Conversation(): React.JSX.Element {
  return (
    <main className="conversation">
      <div className="hero">
        <h1 className="hero-slogan">从一句指令开始。</h1>
        <p className="hero-sub">对话在中，证据在右。引擎尚未接入，这是三栏壳的空态。</p>

        <div className="composer">
          <textarea
            className="composer-input"
            rows={3}
            placeholder="给 Pi 下达任务，或粘贴图片…"
            readOnly
          />
          <div className="composer-tools">
            <button className="chip" type="button" title="附件">
              +
            </button>
            <button className="chip" type="button">
              Ask
            </button>
            <button className="chip" type="button">
              模型
            </button>
            <span className="composer-spacer" />
            <span className="context-meter" title="ContextMeter" />
            <button className="send" type="button" title="发送" disabled>
              ↑
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
