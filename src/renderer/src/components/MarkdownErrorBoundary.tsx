import { Component, type ReactNode } from 'react'
import { t } from '../../../shared/i18n'

export class MarkdownErrorBoundary extends Component<
  { source: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidUpdate(previous: { source: string }): void {
    if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false })
  }
  render(): ReactNode {
    return this.state.failed ? (
      <div>
        <p>{t('Markdown 显示失败，以下是完整原文。')}</p>
        <pre className="markdown-plain-fallback">{this.props.source}</pre>
      </div>
    ) : (
      this.props.children
    )
  }
}
