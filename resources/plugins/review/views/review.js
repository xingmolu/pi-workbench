// Code review page for the bundled review plugin. Uses only the public plugin API
// (window.piPlugin); the code host's token stays in Pi Desktop. Everything from the code host
// is inserted as text: descriptions go through a small Markdown renderer that builds nodes.
'use strict'

const api = window.piPlugin
const $ = (id) => document.getElementById(id)
const english = api.locale === 'en'
const tr = (zh, en) => (english ? en : zh)

// ---------------------------------------------------------------------------------------------
// Building blocks

/** Fixed icon markup; never built from data. */
const ICONS = {
  refresh: '<path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5V5h-2.5"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/>',
  open: '<path d="M8.5 3.5h4v4M12.5 3.5 7 9M11 9.5v3H3.5V5h3"/>',
  link: '<path d="M6.75 9.25 9.25 6.75M7.5 4.5l.9-.9a2.5 2.5 0 0 1 3.54 3.54l-.9.9M8.5 11.5l-.9.9a2.5 2.5 0 0 1-3.54-3.54l.9-.9"/>',
  send: '<path d="M8 13V3.5M4 7.25 8 3.25l4 4"/>',
  sparkle: '<path d="M8 2.5 9.2 6.8 13.5 8 9.2 9.2 8 13.5 6.8 9.2 2.5 8l4.3-1.2Z"/>',
  chevron: '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>',
  chevronRight: '<path d="m6.25 4.5 3.5 3.5-3.5 3.5"/>',
  check: '<path d="m3.75 8.25 2.75 2.75 5.75-6"/>',
  cross: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
  dot: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
  pending:
    '<circle cx="8" cy="8" r="5"/><path d="M8 3a5 5 0 0 1 0 10" fill="currentColor" stroke="none"/>',
  pull: '<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="12.25" r="1.5"/><path d="M4.5 5.25v5.5M11.5 10.75V6.5a2 2 0 0 0-2-2H7.5m0 0L9 3m-1.5 1.5L9 6"/>',
  merged:
    '<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5.25v5.5M4.5 5.25c0 2 2 2.75 5.5 2.75"/>',
  draft:
    '<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="12.25" r="1.5"/><path d="M4.5 5.25v5.5M11.5 6v.5M11.5 8.5v.5"/>',
  closed:
    '<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="12.25" r="1.5"/><path d="M4.5 5.25v5.5M9.75 3.75l3.5 3.5M13.25 3.75l-3.5 3.5"/>',
  folder: '<path d="M2.5 4.5h4l1.25 1.5h5.75v6.5h-11Z"/>',
  file: '<path d="M4 2.5h5l3 3v8H4Z M9 2.5v3h3"/>',
  commit: '<circle cx="8" cy="8" r="2.5"/><path d="M2 8h3.5M10.5 8H14"/>',
  edit: '<path d="M10.5 3.5l2 2L6 12H4v-2Z"/>',
  local: '<rect x="2.5" y="3.5" width="11" height="7.5" rx="1"/><path d="M5.5 13.5h5"/>',
  upload: '<path d="M8 11.5V4M5 7l3-3 3 3M3.5 12.5h9"/>'
}

function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon', `icon-${name}`)
  svg.innerHTML = ICONS[name]
  return svg
}

/** Builds an element; strings become text nodes, never HTML. */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity))
    if (child !== null && child !== undefined && child !== false)
      node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child)
  return node
}

/** Replaces an element's children with nodes from nested arrays, skipping empty slots. */
function fill(node, ...children) {
  node.replaceChildren(
    ...children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false)
  )
}

/** A login's initial on a colour derived from the login. */
function avatar(login, size = 18) {
  let hash = 0
  for (const char of login || '?') hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return el('span', {
    class: 'avatar',
    style: `--hue:${hash % 360};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px`,
    'aria-hidden': 'true',
    text: (login || '?').slice(0, 1).toUpperCase()
  })
}

function relativeTime(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return tr('刚刚', 'just now')
  if (seconds < 3600)
    return tr(`${Math.floor(seconds / 60)} 分钟前`, `${Math.floor(seconds / 60)}m ago`)
  if (seconds < 86400)
    return tr(`${Math.floor(seconds / 3600)} 小时前`, `${Math.floor(seconds / 3600)}h ago`)
  if (seconds < 86400 * 30)
    return tr(`${Math.floor(seconds / 86400)} 天前`, `${Math.floor(seconds / 86400)}d ago`)
  return new Date(iso).toLocaleDateString(english ? 'en' : 'zh-CN')
}

const describeError = (error) => {
  if (
    error &&
    error.code === 'PERMISSION_DENIED' &&
    /拒绝|declined|denied/i.test(error.message || '')
  )
    return null
  return (error && error.message) || tr('操作失败', 'Action failed')
}

let toastTimer = 0
function toast(message, kind = 'error') {
  const box = $('toast')
  if (!message) return void (box.hidden = true)
  fill(box, icon(kind === 'info' ? 'check' : 'cross', 14), el('span', { text: message }))
  box.className = `toast is-${kind}`
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (box.hidden = true), kind === 'info' ? 3500 : 7000)
}

function skeleton(lines = 3) {
  return el(
    'div',
    { class: 'skeleton', 'aria-busy': 'true', 'aria-label': tr('正在加载', 'Loading') },
    Array.from({ length: lines }, (_, index) =>
      el('span', { style: `width:${[72, 92, 56, 84, 64][index % 5]}%` })
    )
  )
}

// ---------------------------------------------------------------------------------------------
// Markdown (descriptions): headings, paragraphs, lists, quotes, code, tables, emphasis, links.

function inline(text) {
  const nodes = []
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const [token] = match
    if (match[1]) nodes.push(el('code', { text: token.slice(1, -1) }))
    else if (match[2]) nodes.push(el('strong', {}, inline(token.slice(2, -2))))
    else if (match[3]) nodes.push(el('em', {}, inline(token.slice(1, -1))))
    else {
      const label = match[4] ? token.slice(1, token.indexOf('](')) : token
      const url = match[5] || match[6]
      nodes.push(
        el('a', {
          href: '#',
          title: url,
          text: label,
          onclick: (event) => {
            event.preventDefault()
            api.call('shell.openExternal', { url }).catch(() => undefined)
          }
        })
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function markdown(source) {
  const root = el('div', { class: 'markdown' })
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  const paragraph = []
  const flush = () => {
    if (paragraph.length) root.append(el('p', {}, inline(paragraph.join(' '))))
    paragraph.length = 0
  }
  while (index < lines.length) {
    const line = lines[index]
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const code = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence[1]))
        code.push(lines[index++])
      index++
      root.append(el('pre', {}, el('code', { text: code.join('\n') })))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      root.append(
        el(`h${Math.min(6, heading[1].length + 1)}`, {}, inline(heading[2].replace(/\s#+$/, '')))
      )
      index++
      continue
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      flush()
      root.append(el('hr'))
      index++
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quote = []
      while (index < lines.length && /^\s*>/.test(lines[index]))
        quote.push(lines[index++].replace(/^\s*>\s?/, ''))
      root.append(el('blockquote', {}, markdown(quote.join('\n')).childNodes))
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] || '')) {
      flush()
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim())
      const head = cells(line)
      index += 2
      const body = []
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]))
        body.push(cells(lines[index++]))
      root.append(
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                head.map((cell) => el('th', {}, inline(cell)))
              )
            ),
            el(
              'tbody',
              {},
              body.map((row) =>
                el(
                  'tr',
                  {},
                  row.map((cell) => el('td', {}, inline(cell)))
                )
              )
            )
          )
        )
      )
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[2])
      const list = el(ordered ? 'ol' : 'ul')
      const baseIndent = item[1].length
      while (index < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
        if (!next) {
          // A wrapped line continues the previous item.
          if (lines[index].trim() && /^\s{2,}/.test(lines[index]) && list.lastChild) {
            list.lastChild.append(' ', ...inline(lines[index].trim()))
            index++
            continue
          }
          break
        }
        if (next[1].length > baseIndent && list.lastChild) {
          const nested = []
          while (index < lines.length) {
            const deeper = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[index])
            if (!deeper || deeper[1].length <= baseIndent) break
            nested.push(lines[index++].slice(baseIndent + 2))
          }
          list.lastChild.append(...markdown(nested.join('\n')).childNodes)
          continue
        }
        if (next[1].length < baseIndent) break
        const task = /^\[([ xX])\]\s+(.*)$/.exec(next[3])
        list.append(
          el(
            'li',
            task ? { class: 'task' } : {},
            task
              ? el('span', {
                  class: task[1] === ' ' ? 'box' : 'box is-done',
                  'aria-hidden': 'true'
                })
              : null,
            inline(task ? task[2] : next[3])
          )
        )
        index++
      }
      root.append(list)
      continue
    }
    if (!line.trim()) {
      flush()
      index++
      continue
    }
    paragraph.push(line.trim())
    index++
  }
  flush()
  return root
}

// ---------------------------------------------------------------------------------------------
// Diffs

/** Splits a unified diff of many files into one entry per file. */
function parsePatch(patch) {
  const files = []
  let current = null
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0, lines: [], status: 'modified' }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('new file')) current.status = 'added'
    else if (line.startsWith('deleted file')) current.status = 'removed'
    else if (line.startsWith('Binary files')) current.binary = true
    else if (line.startsWith('@@') || current.lines.length) {
      current.lines.push(line)
      if (line.startsWith('+')) current.additions++
      else if (line.startsWith('-')) current.deletions++
    }
  }
  return files.map(({ lines, ...file }) => ({ ...file, patch: lines.join('\n') }))
}

/** Rows with old and new line numbers, and the unchanged stretches between hunks. */
function diffRows(patch) {
  const rows = []
  let oldLine = 0
  let newLine = 0
  let previousEnd = 1
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      const skipped = oldLine - previousEnd
      // Nothing hidden and nothing to name: the hunk simply follows on.
      if (skipped > 0 || hunk[5].trim())
        rows.push({ type: 'gap', count: skipped > 0 ? skipped : 0, text: hunk[5].trim() })
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) rows.push({ type: 'add', newNo: newLine++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ type: 'del', oldNo: oldLine++, text: line.slice(1) })
    else if (line !== '' || rows.length) {
      rows.push({ type: 'ctx', oldNo: oldLine++, newNo: newLine++, text: line.slice(1) })
    }
    previousEnd = oldLine
  }
  // A trailing empty context line comes from the final newline, not the file.
  while (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '')
    rows.pop()
  return rows
}

const fileAnchor = (path) => `file-${encodeURIComponent(path)}`

function diffFile(file) {
  const statusLabel = {
    added: tr('新增', 'Added'),
    removed: tr('删除', 'Deleted'),
    renamed: tr('重命名', 'Renamed')
  }[file.status]
  const body = el('div', { class: 'diff-body' })
  const section = el(
    'section',
    { class: 'diff-file', id: fileAnchor(file.path), 'data-path': file.path },
    el(
      'header',
      { class: 'diff-file-head' },
      el(
        'button',
        {
          type: 'button',
          class: 'diff-toggle',
          'aria-expanded': 'true',
          'aria-label': tr(`折叠 ${file.path}`, `Collapse ${file.path}`),
          onclick: (event) => {
            const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true'
            event.currentTarget.setAttribute('aria-expanded', String(!expanded))
            body.hidden = expanded
          }
        },
        icon('chevron', 14)
      ),
      el(
        'span',
        { class: 'diff-path', title: file.path },
        file.previousPath ? `${file.previousPath} → ` : '',
        file.path
      ),
      statusLabel
        ? el('span', { class: `status-chip is-${file.status}`, text: statusLabel })
        : null,
      el(
        'span',
        { class: 'counts' },
        el('span', { class: 'plus', text: `+${file.additions}` }),
        el('span', { class: 'minus', text: `−${file.deletions}` })
      )
    ),
    body
  )
  if (!file.patch) {
    body.append(
      el('div', {
        class: 'diff-note',
        text: file.untracked
          ? tr('未跟踪的新文件，暂存后可以看到内容', 'Untracked file; stage it to see its contents')
          : file.binary
            ? tr('二进制文件', 'Binary file')
            : tr('没有可显示的文本差异', 'No text diff to show')
      })
    )
    return section
  }
  const table = el('div', {
    class: 'diff-table',
    role: 'table',
    'aria-label': tr(`${file.path} 的差异`, `Diff of ${file.path}`)
  })
  for (const row of diffRows(file.patch).slice(0, 6000)) {
    if (row.type === 'gap') {
      table.append(
        el(
          'div',
          { class: 'diff-gap', role: 'row' },
          el('span', {
            class: 'gap-label',
            text: row.count ? tr(`${row.count} 行未改动`, `${row.count} unmodified lines`) : ''
          }),
          row.text ? el('span', { class: 'gap-context', text: row.text }) : null
        )
      )
      continue
    }
    table.append(
      el(
        'div',
        { class: `diff-row is-${row.type}`, role: 'row' },
        el('span', { class: 'ln', text: row.oldNo ?? '' }),
        el('span', { class: 'ln', text: row.newNo ?? '' }),
        el('span', {
          class: 'sign',
          text: row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''
        }),
        el('code', { class: 'code', text: row.text || ' ' })
      )
    )
  }
  body.append(table)
  return section
}

/** Directory tree of changed files, filterable, in the order the diffs appear. */
function fileTree(files, onPick) {
  const root = { dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    }
    node.files.push({ name: parts[parts.length - 1], file })
  }
  // Single-child folders collapse into one row, as in most code review tools.
  const render = (node, depth) => {
    const items = []
    for (let [name, child] of node.dirs) {
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [childName, grandchild] = [...child.dirs][0]
        name = `${name}/${childName}`
        child = grandchild
      }
      const nested = el('ul', {}, render(child, depth + 1))
      items.push(
        el(
          'li',
          { class: 'tree-dir' },
          el(
            'button',
            {
              type: 'button',
              class: 'tree-row',
              style: `--depth:${depth}`,
              'aria-expanded': 'true',
              onclick: (event) => {
                const open = event.currentTarget.getAttribute('aria-expanded') === 'true'
                event.currentTarget.setAttribute('aria-expanded', String(!open))
                nested.hidden = open
              }
            },
            icon('chevron', 12),
            icon('folder', 14),
            el('span', { class: 'tree-name', text: name })
          ),
          nested
        )
      )
    }
    for (const { name, file } of node.files)
      items.push(
        el(
          'li',
          {},
          el(
            'button',
            {
              type: 'button',
              class: 'tree-row tree-file',
              style: `--depth:${depth}`,
              'data-path': file.path,
              title: file.path,
              onclick: () => onPick(file.path)
            },
            el('span', {
              class: `tree-mark is-${file.status || 'modified'}`,
              'aria-hidden': 'true'
            }),
            el('span', { class: 'tree-name', text: name }),
            el(
              'span',
              { class: 'counts' },
              file.additions ? el('span', { class: 'plus', text: `+${file.additions}` }) : null,
              file.deletions ? el('span', { class: 'minus', text: `−${file.deletions}` }) : null
            )
          )
        )
      )
    return items
  }
  return el('ul', { class: 'tree' }, render(root, 0))
}

/** Diffs with a file tree beside them; the tree follows the file being read. */
function changesView(files) {
  if (!files.length)
    return el(
      'div',
      { class: 'empty-state' },
      icon('check', 20),
      el('p', { text: tr('没有改动', 'No changes') })
    )
  const scrollTo = (path) =>
    document
      .getElementById(fileAnchor(path))
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const tree = fileTree(files, scrollTo)
  const filter = el('input', {
    type: 'search',
    class: 'tree-filter',
    placeholder: tr('筛选文件…', 'Filter files…'),
    'aria-label': tr('筛选文件', 'Filter files'),
    oninput: (event) => {
      const needle = event.target.value.trim().toLowerCase()
      for (const row of tree.querySelectorAll('.tree-file'))
        row.parentElement.hidden =
          Boolean(needle) && !row.dataset.path.toLowerCase().includes(needle)
      for (const section of diffs.querySelectorAll('.diff-file'))
        section.hidden = Boolean(needle) && !section.dataset.path.toLowerCase().includes(needle)
    }
  })
  const diffs = el('div', { class: 'diffs' }, files.map(diffFile))
  const totals = files.reduce(
    (sum, file) => [sum[0] + file.additions, sum[1] + file.deletions],
    [0, 0]
  )
  const view = el(
    'div',
    { class: 'changes' },
    diffs,
    el(
      'aside',
      { class: 'files-pane', 'aria-label': tr('改动的文件', 'Changed files') },
      el(
        'div',
        { class: 'files-pane-head' },
        el('span', { text: tr(`${files.length} 个文件`, `${files.length} files`) }),
        el(
          'span',
          { class: 'counts' },
          el('span', { class: 'plus', text: `+${totals[0]}` }),
          el('span', { class: 'minus', text: `−${totals[1]}` })
        )
      ),
      filter,
      tree
    )
  )
  // Highlight the file at the top of the reading area.
  requestAnimationFrame(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (!visible) return
        for (const row of tree.querySelectorAll('.tree-file'))
          row.classList.toggle('is-current', row.dataset.path === visible.target.dataset.path)
      },
      { root: $('detail'), rootMargin: '-56px 0px -70% 0px' }
    )
    for (const section of diffs.querySelectorAll('.diff-file')) observer.observe(section)
  })
  return view
}

// ---------------------------------------------------------------------------------------------
// State

const state = {
  repo: null,
  pulls: null,
  pullsError: null,
  status: null,
  outgoing: null,
  localError: null,
  selection: { kind: 'working' },
  tab: 'summary',
  detail: null, // { number, data } | { number, error }
  files: null, // { number, data } | { number, error }
  busy: false,
  loading: false,
  query: '',
  mergeMethod: 'merge'
}

const MERGE_METHODS = {
  merge: tr('合并提交', 'Create a merge commit'),
  squash: tr('压缩合并', 'Squash and merge'),
  rebase: tr('变基合并', 'Rebase and merge')
}

function selected(kind, number) {
  const current = state.selection
  return current.kind === kind && (number === undefined || current.number === number)
}

// ---------------------------------------------------------------------------------------------
// List

function pullState(pull) {
  if (pull.state === 'merged')
    return { key: 'merged', icon: 'merged', label: tr('已合并', 'Merged') }
  if (pull.state === 'closed')
    return { key: 'closed', icon: 'closed', label: tr('已关闭', 'Closed') }
  if (pull.draft) return { key: 'draft', icon: 'draft', label: tr('草稿', 'Draft') }
  return { key: 'open', icon: 'pull', label: tr('打开', 'Open') }
}

function listItem({ kind, number, title, meta, author, leading }) {
  const active = selected(kind, number)
  return el(
    'li',
    {},
    el(
      'button',
      {
        type: 'button',
        class: active ? 'item is-active' : 'item',
        'aria-current': active ? 'true' : undefined,
        'data-kind': kind,
        'data-number': number,
        onclick: () => select({ kind, number })
      },
      el('span', { class: 'item-title' }, leading, el('span', { text: title })),
      el(
        'span',
        { class: 'item-meta' },
        author
          ? [
              avatar(author, 16),
              el('span', { text: author }),
              el('span', { class: 'sep', text: '·' })
            ]
          : null,
        meta
      )
    )
  )
}

function matches(pull) {
  const needle = state.query.trim().toLowerCase()
  if (!needle) return true
  return (
    pull.title.toLowerCase().includes(needle) ||
    `#${pull.number}`.includes(needle.replace(/^#?/, '#')) ||
    pull.author.toLowerCase().includes(needle)
  )
}

function group(title, items, empty) {
  return el(
    'section',
    { class: 'group' },
    el('h2', { text: title }),
    items.length ? el('ul', {}, items) : empty ? el('p', { class: 'list-note', text: empty }) : null
  )
}

function renderList() {
  const repo = state.repo
  const repoLine = $('repo')
  fill(
    repoLine,
    repo && repo.owner
      ? [
          icon('pull', 13),
          el('span', { text: `${repo.owner}/${repo.repo}` }),
          repo.viewer
            ? [
                el('span', { class: 'sep', text: '·' }),
                avatar(repo.viewer, 14),
                el('span', { text: repo.viewer })
              ]
            : null
        ]
      : [icon('local', 13), el('span', { text: tr('本地仓库', 'Local repository') })]
  )
  $('refresh').classList.toggle('is-spinning', state.loading)

  const account = $('account')
  if (repo && repo.reason) {
    account.hidden = false
    fill(
      account,
      el('p', { text: repo.reason }),
      repo.provider === 'github' && !repo.viewer
        ? el('button', {
            type: 'button',
            class: 'button is-small',
            text: tr('登录 GitHub', 'Sign in to GitHub'),
            onclick: () => api.call('ui.openSettings', { section: 'forges' })
          })
        : null
    )
  } else account.hidden = true

  const local = []
  const files = state.status ? state.status.files.length : 0
  if (!state.query.trim())
    local.push(
      listItem({
        kind: 'working',
        title: tr('未提交的改动', 'Uncommitted changes'),
        leading: icon('edit', 14),
        meta: el('span', {
          text: state.status
            ? tr(`${files} 个文件`, `${files} files`)
            : state.localError || tr('读取中…', 'Loading…')
        })
      })
    )
  if (!state.query.trim() && state.outgoing && state.outgoing.commits.length)
    local.push(
      listItem({
        kind: 'outgoing',
        title: tr('未推送的提交', 'Unpushed commits'),
        leading: icon('upload', 14),
        meta: [
          el('span', { text: `${state.outgoing.branch || 'HEAD'} → ${state.outgoing.base}` }),
          el('span', {
            class: 'pill',
            text: String(state.outgoing.commits.length + state.outgoing.moreCommits)
          })
        ]
      })
    )
  const sections = []
  if (local.length) sections.push(group(tr('本地', 'Local'), local))
  if (state.pulls) {
    const items = (pulls) =>
      pulls.filter(matches).map((pull) =>
        listItem({
          kind: 'pull',
          number: pull.number,
          title: pull.title,
          author: pull.author,
          meta: [
            el('span', { text: relativeTime(pull.updatedAt) }),
            pull.draft ? el('span', { class: 'pill', text: tr('草稿', 'Draft') }) : null
          ]
        })
      )
    sections.push(
      group(
        tr('我创建的', 'Created by me'),
        items(state.pulls.mine),
        state.query ? '' : tr('没有打开的拉取请求', 'No open pull requests')
      )
    )
    sections.push(
      group(
        tr('待我审查', 'Waiting for my review'),
        items(state.pulls.reviewRequested),
        state.query ? '' : tr('没有待审查的', 'Nothing to review')
      )
    )
    const others = items(state.pulls.others)
    if (others.length) sections.push(group(tr('其他打开的', 'Other open'), others))
  } else if (state.pullsError)
    sections.push(el('p', { class: 'list-note is-error', text: state.pullsError }))
  else if (state.loading && repo && repo.viewer) sections.push(skeleton(4))
  fill($('sections'), sections)
}

// ---------------------------------------------------------------------------------------------
// Actions

function button(label, onclick, options = {}) {
  return el(
    'button',
    {
      type: 'button',
      class: `button${options.primary ? ' is-primary' : ''}${options.quiet ? ' is-quiet' : ''}`,
      disabled: state.busy || options.disabled,
      title: options.title,
      onclick
    },
    options.icon ? icon(options.icon, 14) : null,
    el('span', { text: label })
  )
}

function iconButton(name, label, onclick) {
  return el(
    'button',
    { type: 'button', class: 'icon-button', 'aria-label': label, title: label, onclick },
    icon(name, 15)
  )
}

async function run(task, success) {
  if (state.busy) return
  state.busy = true
  renderDetail()
  try {
    const result = await task()
    if (success) toast(success, 'info')
    return result ?? true
  } catch (error) {
    const message = describeError(error)
    if (message) toast(message)
  } finally {
    state.busy = false
    renderDetail()
  }
}

const reviewWithPi = (text) => run(() => api.call('chat.draft', { text }))

/** A split button: merge with the chosen method, or pick another from its menu. */
function mergeButton(pull, onMerge) {
  const menu = el(
    'div',
    { class: 'menu', role: 'menu', hidden: true },
    Object.entries(MERGE_METHODS).map(([method, label]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': String(state.mergeMethod === method),
          onclick: () => {
            state.mergeMethod = method
            menu.hidden = true
            renderDetail()
          }
        },
        el(
          'span',
          { class: 'menu-check' },
          state.mergeMethod === method ? icon('check', 14) : null
        ),
        el('span', { text: label })
      )
    )
  )
  const disabled = state.busy || pull.mergeable === false || pull.draft
  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'split-toggle',
      'aria-label': tr('合并方式', 'Merge method'),
      'aria-haspopup': 'menu',
      disabled: state.busy,
      onclick: (event) => {
        event.stopPropagation()
        menu.hidden = !menu.hidden
        if (!menu.hidden) {
          const close = () => {
            menu.hidden = true
            document.removeEventListener('click', close)
          }
          document.addEventListener('click', close)
        }
      }
    },
    icon('chevron', 14)
  )
  return el(
    'span',
    { class: 'split' },
    el(
      'button',
      {
        type: 'button',
        class: 'split-main',
        disabled,
        title: MERGE_METHODS[state.mergeMethod],
        onclick: onMerge
      },
      icon('merged', 14),
      el('span', { text: tr('合并', 'Merge') })
    ),
    toggle,
    menu
  )
}

// ---------------------------------------------------------------------------------------------
// Detail views

function toolbar(left, right) {
  return el(
    'header',
    { class: 'toolbar' },
    el('div', { class: 'toolbar-left' }, left),
    el('div', { class: 'toolbar-right' }, right)
  )
}

function segmented(tabs) {
  return el(
    'div',
    { class: 'segmented', role: 'tablist' },
    tabs.map(({ id, label, extra }) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: state.tab === id ? 'tab is-active' : 'tab',
          'aria-selected': String(state.tab === id),
          onclick: () => {
            state.tab = id
            renderDetail()
          }
        },
        el('span', { text: label }),
        extra
      )
    )
  )
}

const REVIEW_LOCAL = tr(
  '请审查当前项目里未提交的改动（用 git status、git diff 和 git diff --cached 查看）。重点找正确性问题、遗漏的边界情况和缺少的测试，按严重程度列出发现并引用文件和行号。先不要修改文件。',
  'Review the uncommitted changes in this project (see git status, git diff and git diff --cached). Look for correctness bugs, missed edge cases and missing tests; list findings by severity with file and line references. Do not change any files yet.'
)

function workingDetail() {
  const status = state.status
  const bar = toolbar(
    el(
      'span',
      { class: 'toolbar-title' },
      icon('edit', 15),
      tr('未提交的改动', 'Uncommitted changes')
    ),
    status
      ? [
          button(
            tr('全部暂存', 'Stage all'),
            () =>
              run(
                () => api.call('git.stage', { paths: status.files.map((file) => file.path) }),
                tr('已暂存', 'Staged')
              ).then(refreshLocal),
            { disabled: !status.files.length, quiet: true }
          ),
          button(tr('用 Pi 审查', 'Review with Pi'), () => reviewWithPi(REVIEW_LOCAL), {
            primary: true,
            icon: 'sparkle',
            disabled: !status.files.length
          })
        ]
      : null
  )
  if (!status)
    return [
      bar,
      el(
        'div',
        { class: 'page' },
        state.localError ? el('div', { class: 'empty-state', text: state.localError }) : skeleton(5)
      )
    ]
  const staged = status.files.filter((file) => file.index !== ' ' && file.index !== '?').length
  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'p',
      { class: 'byline' },
      icon('local', 14),
      el('span', {
        text: status.branch
          ? tr(`分支 ${status.branch}`, `Branch ${status.branch}`)
          : tr('没有分支', 'No branch')
      }),
      el('span', { class: 'sep', text: '·' }),
      el('span', {
        text: tr(
          `${status.files.length} 个文件，${staged} 个已暂存`,
          `${status.files.length} files, ${staged} staged`
        )
      })
    )
  )
  const compose = el(
    'form',
    {
      class: 'composer',
      onsubmit: (event) => {
        event.preventDefault()
        const message = event.target.elements.message.value.trim()
        if (!message) return
        run(() => api.call('git.commit', { message }), tr('已提交', 'Committed')).then((result) => {
          if (result) event.target.reset()
          refreshLocal()
        })
      }
    },
    el('textarea', {
      name: 'message',
      rows: 2,
      placeholder: tr('提交信息（提交已暂存的改动）', 'Commit message (commits staged changes)'),
      'aria-label': tr('提交信息', 'Commit message')
    }),
    el(
      'div',
      { class: 'composer-actions' },
      el('button', {
        type: 'submit',
        class: 'button is-primary',
        disabled: state.busy || !staged,
        text: tr('提交', 'Commit')
      })
    )
  )
  const diffHolder = el('div', { id: 'working-diff' }, skeleton(6))
  loadWorkingDiff()
  return [
    bar,
    el('div', { class: 'page is-wide' }, head, status.files.length ? compose : null, diffHolder)
  ]
}

let workingDiffToken = 0
async function loadWorkingDiff() {
  const token = ++workingDiffToken
  try {
    const [unstaged, staged] = await Promise.all([
      api.call('git.diff', { staged: false }),
      api.call('git.diff', { staged: true })
    ])
    if (token !== workingDiffToken) return
    const files = [...parsePatch(staged.patch), ...parsePatch(unstaged.patch)]
    for (const file of state.status?.files || [])
      if (file.index === '?')
        files.push({
          path: file.path,
          additions: 0,
          deletions: 0,
          patch: '',
          untracked: true,
          status: 'added'
        })
    $('working-diff')?.replaceChildren(changesView(files))
  } catch (error) {
    if (token === workingDiffToken)
      $('working-diff')?.replaceChildren(
        el('div', { class: 'empty-state', text: describeError(error) || '' })
      )
  }
}

function outgoingDetail() {
  const outgoing = state.outgoing
  if (!outgoing)
    return [
      toolbar(el('span', { class: 'toolbar-title', text: tr('未推送的提交', 'Unpushed commits') })),
      el('div', { class: 'page' }, skeleton(4))
    ]
  const total = outgoing.commits.length + outgoing.moreCommits
  const prompt = tr(
    `请审查分支 ${outgoing.branch} 上还没推送的提交（git log ${outgoing.base}..HEAD，git diff ${outgoing.base}...HEAD）。重点找正确性问题、遗漏的边界情况和缺少的测试，按严重程度列出发现并引用文件和行号。先不要修改文件。`,
    `Review the unpushed commits on ${outgoing.branch} (git log ${outgoing.base}..HEAD, git diff ${outgoing.base}...HEAD). Look for correctness bugs, missed edge cases and missing tests; list findings by severity with file and line references. Do not change any files yet.`
  )
  return [
    toolbar(
      el(
        'span',
        { class: 'toolbar-title' },
        icon('upload', 15),
        tr('未推送的提交', 'Unpushed commits')
      ),
      [
        button(
          tr('推送', 'Push'),
          () => run(() => api.call('git.push', {}), tr('已推送', 'Pushed')).then(refreshLocal),
          { quiet: true, icon: 'upload' }
        ),
        button(tr('用 Pi 审查', 'Review with Pi'), () => reviewWithPi(prompt), {
          primary: true,
          icon: 'sparkle'
        })
      ]
    ),
    el(
      'div',
      { class: 'page is-wide' },
      el(
        'div',
        { class: 'page-head' },
        el(
          'p',
          { class: 'byline' },
          el('span', { class: 'branch', text: outgoing.branch || 'HEAD' }),
          icon('chevronRight', 12),
          el('span', { class: 'branch', text: outgoing.base }),
          el('span', { class: 'sep', text: '·' }),
          el('span', { text: tr(`${total} 个提交`, `${total} commits`) })
        )
      ),
      el(
        'ol',
        { class: 'commits' },
        outgoing.commits.map((commit) =>
          el(
            'li',
            {},
            icon('commit', 14),
            el('span', { class: 'commit-subject', text: commit.subject }),
            el('code', { text: commit.hash.slice(0, 7) }),
            el(
              'span',
              { class: 'commit-meta' },
              avatar(commit.author, 16),
              el('span', { text: relativeTime(commit.date) })
            )
          )
        )
      ),
      changesView(parsePatch(outgoing.patch))
    )
  ]
}

const CHECK_TONE = {
  success: 'ok',
  failure: 'bad',
  timed_out: 'bad',
  action_required: 'warn',
  cancelled: 'muted',
  skipped: 'muted',
  neutral: 'muted'
}

function checkRow(check) {
  const tone = check.status !== 'completed' ? 'warn' : CHECK_TONE[check.conclusion] || 'muted'
  const name =
    tone === 'ok' ? 'check' : tone === 'bad' ? 'cross' : tone === 'warn' ? 'pending' : 'dot'
  const row = el(
    'li',
    { class: `check is-${tone}` },
    el('span', { class: 'check-icon' }, icon(name, 14)),
    el('span', { class: 'check-name', text: check.name })
  )
  if (check.url) {
    row.classList.add('is-link')
    row.title = check.url
    row.addEventListener('click', () =>
      api.call('shell.openExternal', { url: check.url }).catch(() => undefined)
    )
  }
  return row
}

function mergeStatus(pull) {
  if (pull.state === 'merged') return { tone: 'merged', text: tr('已合并', 'Merged') }
  if (pull.state === 'closed') return { tone: 'bad', text: tr('已关闭', 'Closed') }
  if (pull.mergeable === null)
    return {
      tone: 'warn',
      text: tr('GitHub 正在计算能否合并…', 'GitHub is still checking mergeability…')
    }
  if (!pull.mergeable) return { tone: 'bad', text: tr('有合并冲突', 'Has merge conflicts') }
  if (pull.mergeableState === 'blocked')
    return { tone: 'warn', text: tr('被分支保护规则阻止', 'Blocked by branch protection') }
  if (pull.mergeableState === 'unstable')
    return {
      tone: 'warn',
      text: tr('可以合并，但有检查没通过', 'Mergeable; some checks are failing')
    }
  if (pull.mergeableState === 'behind')
    return { tone: 'warn', text: tr('落后于目标分支', 'Behind the base branch') }
  return { tone: 'ok', text: tr('可以合并，没有冲突', 'Can merge without conflicts') }
}

function fact(title, ...content) {
  return el('section', { class: 'fact' }, el('h3', { text: title }), content)
}

function pullDetail(number) {
  const loaded = state.detail && state.detail.number === number ? state.detail : null
  if (!loaded || loaded.error) {
    const bar = toolbar(el('span', { class: 'toolbar-title', text: `#${number}` }))
    return [
      bar,
      el(
        'div',
        { class: 'page' },
        loaded ? el('div', { class: 'empty-state', text: loaded.error }) : skeleton(6)
      )
    ]
  }
  const pull = loaded.data
  const status = pullState(pull)
  const prompt = tr(
    `请审查拉取请求 #${pull.number}「${pull.title}」（${pull.headRef} → ${pull.baseRef}，${pull.url}）。先用 git fetch origin pull/${pull.number}/head 取到它的提交，再用 git diff origin/${pull.baseRef}...FETCH_HEAD 查看改动。重点找正确性问题、遗漏的边界情况和缺少的测试，按严重程度列出发现并引用文件和行号，最后整理成可以直接发到这个拉取请求上的评论。不要修改文件，也不要推送。`,
    `Review pull request #${pull.number} "${pull.title}" (${pull.headRef} → ${pull.baseRef}, ${pull.url}). Fetch it with git fetch origin pull/${pull.number}/head, then read git diff origin/${pull.baseRef}...FETCH_HEAD. Look for correctness bugs, missed edge cases and missing tests; list findings by severity with file and line references, and finish with a comment ready to post on the pull request. Do not change files or push.`
  )
  const merge = () =>
    run(
      () =>
        api.call('forge.merge', {
          number: pull.number,
          method: state.mergeMethod,
          headSha: pull.headSha
        }),
      tr('已合并', 'Merged')
    ).then(() => {
      loadPull(pull.number)
      loadPulls()
    })
  const bar = toolbar(
    segmented([
      { id: 'summary', label: tr('概要', 'Summary') },
      {
        id: 'changes',
        label: tr('改动', 'Changes'),
        extra: el(
          'span',
          { class: 'counts' },
          el('span', { class: 'plus', text: `+${pull.additions}` }),
          el('span', { class: 'minus', text: `−${pull.deletions}` })
        )
      }
    ]),
    [
      iconButton('link', tr('复制链接', 'Copy link'), () =>
        navigator.clipboard.writeText(pull.url).then(
          () => toast(tr('链接已复制', 'Link copied'), 'info'),
          () => toast(tr('无法复制', "Couldn't copy"))
        )
      ),
      iconButton('open', tr('在 GitHub 打开', 'Open on GitHub'), () =>
        api.call('shell.openExternal', { url: pull.url })
      ),
      button(tr('用 Pi 审查', 'Review with Pi'), () => reviewWithPi(prompt), {
        icon: 'sparkle',
        quiet: true
      }),
      pull.state === 'open' ? mergeButton(pull, merge) : null
    ]
  )
  if (state.tab === 'changes') {
    const files = state.files && state.files.number === number ? state.files : null
    if (!files) loadFiles(number)
    return [
      bar,
      el(
        'div',
        { class: 'page is-wide' },
        !files
          ? skeleton(8)
          : files.error
            ? el('div', { class: 'empty-state', text: files.error })
            : changesView(files.data)
      )
    ]
  }
  const merging = mergeStatus(pull)
  const repo = state.repo
  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      { class: 'eyebrow' },
      el(
        'span',
        { class: `state-pill is-${status.key}` },
        icon(status.icon, 14),
        el('span', { text: status.label })
      ),
      el('span', { class: 'muted', text: `${repo && repo.repo ? repo.repo : ''} #${pull.number}` })
    ),
    el('h1', { class: 'title', text: pull.title }),
    el(
      'p',
      { class: 'byline' },
      avatar(pull.author, 18),
      el('strong', { text: pull.author }),
      el('span', { class: 'muted', text: relativeTime(pull.updatedAt) }),
      el('span', { class: 'sep', text: '·' }),
      el('span', { class: 'branch', text: pull.headRef }),
      icon('chevronRight', 12),
      el('span', { class: 'branch', text: pull.baseRef })
    )
  )
  const comment = el(
    'form',
    {
      class: 'composer',
      onsubmit: (event) => {
        event.preventDefault()
        const body = event.target.elements.body.value.trim()
        if (!body) return
        run(
          () => api.call('forge.comment', { number: pull.number, body }),
          tr('评论已发表', 'Comment posted')
        ).then((result) => {
          if (result) event.target.reset()
          loadPull(pull.number)
        })
      }
    },
    el('textarea', {
      name: 'body',
      rows: 3,
      placeholder: tr(
        '发表评论，可以粘贴 Pi 的审查结论（发送前会再确认）',
        'Leave a comment; paste Pi’s review here (you confirm before it is posted)'
      ),
      'aria-label': tr('评论', 'Comment')
    }),
    el(
      'div',
      { class: 'composer-actions' },
      el('button', {
        type: 'submit',
        class: 'button',
        disabled: state.busy,
        text: tr('发表评论', 'Comment')
      })
    )
  )
  const facts = el(
    'aside',
    { class: 'facts' },
    fact(
      tr('合并状态', 'Merge status'),
      el(
        'p',
        { class: `status-line is-${merging.tone}` },
        icon(
          merging.tone === 'ok'
            ? 'check'
            : merging.tone === 'bad'
              ? 'cross'
              : merging.tone === 'merged'
                ? 'merged'
                : 'pending',
          14
        ),
        el('span', { text: merging.text })
      )
    ),
    fact(
      tr('评论', 'Comments'),
      el('p', {
        class: 'muted',
        text: pull.comments
          ? tr(`${pull.comments} 条评论`, `${pull.comments} comments`)
          : tr('还没有评论', 'No comments')
      })
    ),
    pull.stack.length
      ? fact(
          tr('叠加的拉取请求', 'Stack'),
          el(
            'ol',
            { class: 'stack' },
            pull.stack.map((item, index) =>
              el(
                'li',
                { class: item.current ? 'is-current' : '' },
                el(
                  'button',
                  {
                    type: 'button',
                    disabled: item.current,
                    onclick: () => select({ kind: 'pull', number: item.number })
                  },
                  el('span', { class: 'stack-index', text: String(index + 1) }),
                  el('span', { class: 'stack-title', text: item.title })
                )
              )
            )
          )
        )
      : null,
    fact(
      tr('审查', 'Reviews'),
      pull.reviews.length
        ? el(
            'ul',
            { class: 'reviews' },
            pull.reviews.map((review) =>
              el(
                'li',
                {},
                avatar(review.author, 16),
                el('span', { text: review.author }),
                el('span', {
                  class: `review-state is-${review.state.toLowerCase()}`,
                  text:
                    {
                      APPROVED: tr('已批准', 'Approved'),
                      CHANGES_REQUESTED: tr('要求修改', 'Changes requested'),
                      COMMENTED: tr('已评论', 'Commented'),
                      DISMISSED: tr('已撤销', 'Dismissed')
                    }[review.state] || review.state.toLowerCase()
                })
              )
            )
          )
        : el('p', { class: 'muted', text: tr('还没有审查', 'No reviews yet') })
    ),
    fact(
      tr('检查', 'Checks'),
      pull.checks.length
        ? el('ul', { class: 'checks' }, pull.checks.map(checkRow))
        : el('p', { class: 'muted', text: tr('没有检查', 'No checks') })
    )
  )
  return [
    bar,
    el(
      'div',
      { class: 'page summary' },
      el(
        'div',
        { class: 'summary-main' },
        head,
        el(
          'div',
          { class: 'description' },
          pull.body
            ? markdown(pull.body)
            : el('p', { class: 'muted', text: tr('没有描述。', 'No description.') })
        ),
        comment
      ),
      facts
    )
  ]
}

// ---------------------------------------------------------------------------------------------
// Ask box: a question about whatever is open, answered by Pi in a new conversation

const askDrafts = new Map()

function askTarget() {
  const selection = state.selection
  if (selection.kind === 'working')
    return state.status && state.status.files.length
      ? {
          key: 'working',
          placeholder: tr('就这些未提交的改动提问', 'Ask about these uncommitted changes'),
          context: tr(
            '关于当前项目里未提交的改动（用 git status、git diff 和 git diff --cached 查看）：',
            'About the uncommitted changes in this project (see git status, git diff and git diff --cached):'
          )
        }
      : null
  if (selection.kind === 'outgoing') {
    const outgoing = state.outgoing
    return outgoing && outgoing.commits.length
      ? {
          key: 'outgoing',
          placeholder: tr('就这些未推送的提交提问', 'Ask about these unpushed commits'),
          context: tr(
            `关于分支 ${outgoing.branch} 上还没推送的提交（git log ${outgoing.base}..HEAD，git diff ${outgoing.base}...HEAD）：`,
            `About the unpushed commits on ${outgoing.branch} (git log ${outgoing.base}..HEAD, git diff ${outgoing.base}...HEAD):`
          )
        }
      : null
  }
  const loaded = state.detail && state.detail.number === selection.number ? state.detail : null
  if (!loaded || loaded.error) return null
  const pull = loaded.data
  return {
    key: `pull:${pull.number}`,
    placeholder: tr('就此 Pull Request 提问', 'Ask about this pull request'),
    context: tr(
      `关于拉取请求 #${pull.number}「${pull.title}」（${pull.headRef} → ${pull.baseRef}，${pull.url}）。可以用 git fetch origin pull/${pull.number}/head 取到它的提交，再用 git diff origin/${pull.baseRef}...FETCH_HEAD 查看改动：`,
      `About pull request #${pull.number} "${pull.title}" (${pull.headRef} → ${pull.baseRef}, ${pull.url}). Fetch it with git fetch origin pull/${pull.number}/head and read git diff origin/${pull.baseRef}...FETCH_HEAD:`
    )
  }
}

function askBox() {
  const target = askTarget()
  if (!target) return null
  const input = el('textarea', {
    rows: 1,
    placeholder: target.placeholder,
    'aria-label': target.placeholder,
    text: askDrafts.get(target.key) || ''
  })
  const send = el(
    'button',
    {
      type: 'submit',
      class: 'ask-send',
      'aria-label': tr('发送', 'Send'),
      title: tr('发送（Enter）', 'Send (Enter)'),
      disabled: !input.value.trim()
    },
    icon('send', 15)
  )
  const grow = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }
  input.addEventListener('input', () => {
    askDrafts.set(target.key, input.value)
    send.disabled = !input.value.trim()
    grow()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  const form = el(
    'form',
    {
      class: 'ask',
      onsubmit: (event) => {
        event.preventDefault()
        const question = input.value.trim()
        if (!question) return
        reviewWithPi(`${target.context}\n\n${question}`).then((result) => {
          if (result === undefined) return
          askDrafts.delete(target.key)
          renderDetail()
        })
      }
    },
    el('span', { class: 'ask-icon', 'aria-hidden': 'true' }, icon('sparkle', 15)),
    input,
    send
  )
  requestAnimationFrame(grow)
  return el('div', { class: 'ask-dock' }, form)
}

function renderDetail() {
  const detail = $('detail')
  const scroll = detail.scrollTop
  const focused = document.activeElement && detail.contains(document.activeElement)
  const asking = focused && document.activeElement.closest('.ask')
  const selection = state.selection
  const content =
    selection.kind === 'working'
      ? workingDetail()
      : selection.kind === 'outgoing'
        ? outgoingDetail()
        : pullDetail(selection.number)
  fill(detail, content, askBox())
  detail.scrollTop = scroll
  if (asking) detail.querySelector('.ask textarea')?.focus()
}

// ---------------------------------------------------------------------------------------------
// Loading

function select(selection) {
  const changed =
    selection.kind !== state.selection.kind || selection.number !== state.selection.number
  state.selection = selection
  if (changed) {
    state.tab = 'summary'
    $('detail').scrollTop = 0
  }
  renderList()
  renderDetail()
  if (selection.kind === 'pull' && !(state.detail && state.detail.number === selection.number))
    loadPull(selection.number)
}

async function loadPull(number) {
  try {
    state.detail = { number, data: await api.call('forge.pull', { number }) }
  } catch (error) {
    state.detail = {
      number,
      error: describeError(error) || tr('无法读取拉取请求', "Can't load the pull request")
    }
  }
  if (state.files && state.files.number === number) state.files = null
  if (selected('pull', number)) renderDetail()
}

let filesLoading = null
async function loadFiles(number) {
  if (filesLoading === number) return
  filesLoading = number
  try {
    state.files = { number, data: await api.call('forge.pullFiles', { number }) }
  } catch (error) {
    state.files = {
      number,
      error: describeError(error) || tr('无法读取改动', "Can't load the changes")
    }
  } finally {
    filesLoading = null
  }
  if (selected('pull', number)) renderDetail()
}

async function loadPulls() {
  if (!state.repo || !state.repo.viewer) {
    state.pulls = null
    state.pullsError = null
    return renderList()
  }
  try {
    state.pulls = await api.call('forge.pulls', {})
    state.pullsError = null
  } catch (error) {
    state.pulls = null
    state.pullsError = describeError(error)
  }
  renderList()
}

async function refreshLocal() {
  try {
    const [status, outgoing] = await Promise.all([
      api.call('git.status', {}),
      api.call('git.outgoing', {})
    ])
    Object.assign(state, { status, outgoing, localError: null })
  } catch (error) {
    Object.assign(state, { status: null, outgoing: null, localError: describeError(error) })
  }
  if (state.selection.kind === 'outgoing' && !(state.outgoing && state.outgoing.commits.length))
    state.selection = { kind: 'working' }
  renderList()
  if (state.selection.kind !== 'pull') renderDetail()
}

let refreshing = null
function refresh() {
  if (refreshing) return refreshing
  state.loading = true
  renderList()
  refreshing = (async () => {
    try {
      state.repo = await api
        .call('forge.repository', {})
        .catch((error) => ({ provider: null, reason: describeError(error) }))
      await Promise.all([refreshLocal(), loadPulls()])
      if (state.selection.kind === 'pull') await loadPull(state.selection.number)
    } finally {
      state.loading = false
      refreshing = null
      renderList()
    }
  })()
  return refreshing
}

// ---------------------------------------------------------------------------------------------
// Wiring

if (english) {
  document.documentElement.lang = 'en'
  $('list-title').textContent = 'Code review'
  $('list-pane').setAttribute('aria-label', 'Review list')
  $('search').placeholder = 'Search or paste a PR link'
  $('search').setAttribute('aria-label', 'Search or paste a PR link')
  $('sections').setAttribute('aria-label', 'Review items')
}
$('refresh').append(icon('refresh', 15))
$('refresh').setAttribute('aria-label', tr('刷新', 'Refresh'))
$('refresh').title = tr('刷新', 'Refresh')
$('search-icon').append(icon('search', 14))
$('refresh').addEventListener('click', () => refresh())

$('search').addEventListener('input', (event) => {
  state.query = event.target.value
  renderList()
})
// A pasted pull request link or "#123" opens that pull request.
$('search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  const value = event.target.value.trim()
  const number = Number((/\/pull\/(\d+)/.exec(value) || /^#?(\d+)$/.exec(value) || [])[1])
  if (number > 0) {
    event.preventDefault()
    state.query = ''
    event.target.value = ''
    select({ kind: 'pull', number })
  }
})

// Up and down move through the list.
$('sections').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const items = [...document.querySelectorAll('#sections .item')]
  const index = items.indexOf(document.activeElement)
  const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  event.preventDefault()
  next.focus()
  next.click()
})

let project = null
api.onContext((context) => {
  if (context.projectPath === project) return
  project = context.projectPath
  Object.assign(state, { detail: null, files: null, selection: { kind: 'working' }, query: '' })
  $('search').value = ''
  refresh()
})
api
  .getContext()
  .then((context) => (project = context.projectPath))
  .finally(() => refresh())
renderDetail()
