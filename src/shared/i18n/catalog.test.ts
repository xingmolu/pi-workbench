import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { en } from './en'
import { resolveLocale, setLocale, t } from './index'

const ROOT = join(__dirname, '../../..')
const SOURCES = [
  'src/renderer/src',
  'src/main',
  'src/agent-host',
  'src/claude-host',
  'src/codex-host',
  'src/shared'
]
const HAN = /[一-鿿]/

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.test\.|\.d\.ts$|\.generated\./.test(name))
        files.push(path)
    }
  }
  for (const source of SOURCES) walk(join(ROOT, source))
  return files
}

/** Chinese strings in code: the ones passed to t(), and any shown without it. */
function scan(): { keys: Map<string, string>; untranslated: string[] } {
  const keys = new Map<string, string>()
  const untranslated: string[] = []
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    if (!HAN.test(text) || text.startsWith('// i18n-ignore-file') || file.endsWith('/en.ts'))
      continue
    const lines = text.split('\n')
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
    const where = (node: ts.Node): string =>
      `${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    // `// i18n-ignore: reason` on the line or the line above keeps a literal as it is.
    const ignored = (node: ts.Node): boolean => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
      return [lines[line], lines[line - 1]].some((text) => text?.includes('i18n-ignore'))
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't' &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        keys.set(node.arguments[0].text, where(node))
        node.arguments.slice(1).forEach(visit)
        return
      }
      const shown =
        ((ts.isStringLiteralLike(node) || ts.isJsxText(node)) && HAN.test(node.text)) ||
        (ts.isTemplateExpression(node) &&
          [node.head, ...node.templateSpans.map((span) => span.literal)].some((part) =>
            HAN.test(part.text)
          ))
      if (shown && !ts.isLiteralTypeNode(node.parent) && !ignored(node))
        untranslated.push(where(node))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { keys, untranslated }
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

describe('interface strings', () => {
  const { keys, untranslated } = scan()

  it('has an English translation for every string passed to t()', () => {
    const missing = [...keys].filter(([key]) => !(key in en)).map(([key, at]) => `${at} ${key}`)
    expect(missing).toEqual([])
  })

  it('keeps the same placeholders in English', () => {
    const mismatched = [...keys.keys()]
      .filter((key) => key in en)
      .filter((key) => {
        const english = new Set(placeholders(en[key]!))
        return placeholders(key).some((name) => !english.has(name) && name !== 'value')
      })
    expect(mismatched).toEqual([])
  })

  it('shows no Chinese without t()', () => {
    expect(untranslated).toEqual([])
  })
})

describe('t()', () => {
  it('translates, fills placeholders in either order and falls back to the source', () => {
    setLocale('en')
    try {
      expect(t('{total} 个会话', { total: 3 })).toBe('3 sessions')
      expect(t('没有收录的文字 {name}', { name: 'x' })).toBe('没有收录的文字 x')
    } finally {
      setLocale('zh-CN')
    }
    expect(t('{total} 个会话', { total: 3 })).toBe('3 个会话')
  })

  it('follows the system language unless one is chosen', () => {
    expect(resolveLocale('system', ['zh-Hans-CN'])).toBe('zh-CN')
    expect(resolveLocale('system', ['en-US', 'zh-CN'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('zh-CN')
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
  })
})
