import { Component, type ReactNode } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import {
  getFiletypeFromFileName,
  registerCustomLanguage,
  type FileDiffMetadata
} from '@pierre/diffs'
import { highlightLanguage } from '../lib/code-highlight'
import { useResolvedTheme } from '../store/theme'

const plainLanguages = new Set<string>()
export function preparePatchLanguage(file: FileDiffMetadata): void {
  for (const name of [file.name, file.prevName]) {
    if (!name) continue
    const lang = getFiletypeFromFileName(name)
    if (lang === 'text' || lang === 'ansi' || highlightLanguage(lang) || plainLanguages.has(lang))
      continue
    // Upstream recognizes more extensions than our deliberately small bundle.
    // A zero-pattern grammar preserves their text without importing more code.
    registerCustomLanguage(lang, async () => ({
      default: [{ name: lang, scopeName: `text.${lang}`, patterns: [], repository: {} }]
    }))
    plainLanguages.add(lang)
  }
}
class PatchBoundary extends Component<
  { children: ReactNode; source: string },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    return this.state.failed ? (
      <>
        <p role="alert">差异显示失败，以下保留完整原始差异。</p>
        <pre>{this.props.source}</pre>
      </>
    ) : (
      this.props.children
    )
  }
}
// Constant application CSS only. Never interpolate source, filenames or HTML.
const css = `
  :host { --diffs-font-family: var(--font-mono, ui-monospace, monospace); --diffs-font-size: 12px; }
  [data-diffs] { --diffs-bg: var(--raised); }
`
export function PierrePatchDiff({
  patch,
  layout
}: {
  patch: string
  layout: 'unified' | 'split'
}): React.JSX.Element {
  const theme = useResolvedTheme()
  return (
    <PatchBoundary key={patch} source={patch}>
      <PatchDiff
        patch={patch}
        disableWorkerPool
        options={{
          diffStyle: layout,
          diffIndicators: 'classic',
          lineDiffType: 'word',
          theme: { dark: 'github-dark', light: 'github-light' },
          themeType: theme,
          preferredHighlighter: 'shiki-js',
          disableFileHeader: true,
          overflow: 'scroll',
          tokenizeMaxLength: 100_000,
          tokenizeMaxLineLength: 4000,
          maxLineDiffLength: 2000,
          unsafeCSS: css
        }}
      />
    </PatchBoundary>
  )
}
