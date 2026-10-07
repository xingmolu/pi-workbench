// Git panel for the bundled Git plugin. Uses only the public plugin API (window.piPlugin).
'use strict'

const api = window.piPlugin
const $ = (id) => document.getElementById(id)
// Pi Desktop's interface language: Chinese unless the host says English.
const english = api.locale === 'en'
const tr = (zh, en) => (english ? en : zh)

const icons = {
  stage: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>',
  unstage: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg>',
  discard:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6.5h6a3 3 0 0 1 0 6H7M6 4 3.5 6.5 6 9" /></svg>'
}

/** The page is written in Chinese; in English its fixed labels are replaced once. */
if (english) {
  document.documentElement.lang = 'en'
  const set = (id, property, value) => {
    const element = $(id)
    if (element) element[property] = value
  }
  set('branch', 'title', 'Current branch')
  set('refresh', 'title', 'Refresh')
  $('refresh')?.setAttribute('aria-label', 'Refresh')
  set('push', 'textContent', 'Push')
  set('message', 'placeholder', 'Commit message (⌘/Ctrl + Enter to commit)')
  $('message')?.setAttribute('aria-label', 'Commit message')
  set('commit', 'textContent', 'Commit')
  set('generate', 'title', 'Write a commit message from the changes')
  $('generate')?.setAttribute('aria-label', 'Write commit message')
  set('unstage-all', 'textContent', 'Unstage all')
  $('staged')?.setAttribute('aria-label', 'Staged changes')
  set('stage-all', 'textContent', 'Stage all')
  $('changes')?.setAttribute('aria-label', 'Unstaged changes')
  for (const [id, text] of [
    ['staged-count', 'Staged'],
    ['changes-count', 'Changes']
  ]) {
    const label = $(id)?.previousElementSibling
    if (label) label.textContent = text
  }
  const summary = document.querySelector('summary')
  if (summary) summary.textContent = 'Recent commits'
}

const state = {
  project: null,
  status: null,
  open: null, // { path, staged }
  busy: false,
  generating: false,
  loading: false,
  error: null,
  epoch: 0 // bumped by explicit refreshes so an open diff reloads
}

const describeError = (error) => {
  const code = error && error.code
  if (code === 'PERMISSION_DENIED' && /拒绝|declined|denied/i.test(error.message || '')) return null
  return (error && error.message) || tr('操作失败', 'Action failed')
}

let noticeTimer = 0

function showNotice(message, kind = 'error') {
  const notice = $('notice')
  if (!message) {
    clearTimeout(noticeTimer)
    notice.hidden = true
    return
  }
  notice.textContent = message
  notice.className = kind === 'info' ? 'notice is-info' : 'notice'
  notice.hidden = false
  clearTimeout(noticeTimer)
  // Confirmations fade on their own; errors stay until the next action.
  if (kind === 'info') noticeTimer = setTimeout(() => (notice.hidden = true), 5000)
}

function badgeFor(code) {
  if (code === '?') return 'U'
  if (code === 'U') return 'C'
  return code === 'R' || code === 'C' ? 'M' : code
}

const BADGE_TITLE = english
  ? { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', C: 'Conflict' }
  : { M: '已修改', A: '新增', D: '已删除', U: '未跟踪', C: '冲突' }

function split(path) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? ['', path] : [path.slice(0, slash + 1), path.slice(slash + 1)]
}

function button(label, icon, onClick) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'icon'
  element.setAttribute('aria-label', label)
  element.title = label
  element.innerHTML = icon
  element.disabled = state.busy
  element.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return element
}

function fileRow(file, staged) {
  const code = staged ? file.index : file.worktree
  const badge = badgeFor(code)
  const row = document.createElement('li')
  const isOpen = state.open && state.open.path === file.path && state.open.staged === staged
  row.className = isOpen ? 'file is-open' : 'file'
  row.tabIndex = 0
  row.dataset.path = file.path
  row.setAttribute('aria-expanded', String(Boolean(isOpen)))

  const mark = document.createElement('span')
  mark.className = `badge is-${badge}`
  mark.textContent = badge
  mark.title = BADGE_TITLE[badge] || code

  const [dir, base] = split(file.path)
  const name = document.createElement('span')
  name.className = 'name'
  name.title = file.path
  const bdi = document.createElement('bdi')
  bdi.textContent = base
  if (dir) {
    const dirSpan = document.createElement('span')
    dirSpan.className = 'dir'
    dirSpan.textContent = ` ${dir.slice(0, -1)}`
    bdi.append(dirSpan)
  }
  name.append(bdi)

  const actions = document.createElement('span')
  actions.className = 'actions'
  if (staged) {
    actions.append(
      button(tr(`取消暂存 ${file.path}`, `Unstage ${file.path}`), icons.unstage, () =>
        act('git.unstage', [file.path])
      )
    )
  } else {
    if (code !== '?')
      actions.append(
        button(
          tr(`丢弃 ${file.path} 的改动`, `Discard changes to ${file.path}`),
          icons.discard,
          () => act('git.discard', [file.path])
        )
      )
    actions.append(
      button(tr(`暂存 ${file.path}`, `Stage ${file.path}`), icons.stage, () =>
        act('git.stage', [file.path])
      )
    )
  }

  row.append(mark, name, actions)
  const toggle = () => {
    state.open = isOpen ? null : { path: file.path, staged }
    render()
  }
  row.addEventListener('click', toggle)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })
  const items = [row]
  if (isOpen) items.push(diffBlock(file, staged, code))
  return items
}

function diffBlock(file, staged, code) {
  const box = document.createElement('li')
  box.className = 'diff'
  box.setAttribute('aria-label', tr(`${file.path} 的差异`, `Diff of ${file.path}`))
  if (code === '?') {
    box.innerHTML = `<div class="note">${tr('新文件，暂存后可查看内容差异', 'New file; stage it to see its diff')}</div>`
    return box
  }
  box.innerHTML = `<div class="note">${tr('正在加载…', 'Loading…')}</div>`
  api
    .call('git.diff', { path: file.path, staged })
    .then(({ patch }) => {
      const pre = document.createElement('pre')
      const lines = patch.split('\n')
      const start = lines.findIndex((line) => line.startsWith('@@'))
      const body = start < 0 ? [] : lines.slice(start)
      if (body.length === 0) {
        box.innerHTML = `<div class="note">${tr('没有可显示的文本差异', 'No text diff to show')}</div>`
        return
      }
      for (const line of body.slice(0, 4000)) {
        if (line === '') continue
        const span = document.createElement('span')
        span.className = line.startsWith('+')
          ? 'line add'
          : line.startsWith('-')
            ? 'line del'
            : line.startsWith('@@')
              ? 'line hunk'
              : 'line'
        span.textContent = line
        pre.append(span)
      }
      box.replaceChildren(pre)
    })
    .catch((error) => {
      box.innerHTML = ''
      const note = document.createElement('div')
      note.className = 'note'
      note.textContent = describeError(error) || tr('无法加载差异', "Can't load the diff")
      box.append(note)
    })
  return box
}

let renderedLists = null

function render() {
  const status = state.status
  $('refresh').classList.toggle('spinning', state.loading)
  const hasStatus = Boolean(status)
  $('compose').hidden = !hasStatus
  $('history').hidden = !hasStatus

  if (!hasStatus) {
    renderedLists = null
    $('branch-name').textContent = '—'
    $('sync').textContent = ''
    $('push').hidden = true
    $('staged-group').hidden = true
    $('changes-group').hidden = true
    const empty = $('empty')
    empty.hidden = !state.error
    empty.textContent = state.error || ''
    return
  }

  $('branch-name').textContent = status.branch || tr('分离的 HEAD', 'Detached HEAD')
  const sync = []
  if (status.ahead) sync.push(`↑${status.ahead}`)
  if (status.behind) sync.push(`↓${status.behind}`)
  $('sync').textContent = sync.join(' ')
  $('sync').title = status.upstream
    ? tr(`跟踪 ${status.upstream}`, `Tracking ${status.upstream}`)
    : tr('尚未推送到远程', 'Not pushed to a remote yet')

  const push = $('push')
  const canPush = Boolean(status.branch) && (!status.upstream || status.ahead > 0)
  push.hidden = !canPush
  push.disabled = state.busy
  push.textContent = status.upstream
    ? tr(`推送 ↑${status.ahead}`, `Push ↑${status.ahead}`)
    : tr('推送分支', 'Push branch')

  const staged = status.files.filter((file) => file.index !== ' ' && file.index !== '?')
  const changes = status.files.filter((file) => file.worktree !== ' ')

  // Rebuild rows only when something they show changed, so polling keeps hover and diffs.
  const listsKey = JSON.stringify([status.files, state.open, state.busy, state.epoch])
  if (listsKey !== renderedLists) {
    renderedLists = listsKey
    $('staged-group').hidden = staged.length === 0
    $('staged-count').textContent = String(staged.length)
    $('staged').replaceChildren(...staged.flatMap((file) => fileRow(file, true)))
    $('unstage-all').disabled = state.busy

    $('changes-group').hidden = changes.length === 0
    $('changes-count').textContent = String(changes.length)
    $('changes').replaceChildren(...changes.flatMap((file) => fileRow(file, false)))
    $('stage-all').disabled = state.busy
  }

  const empty = $('empty')
  empty.hidden = status.files.length > 0
  empty.textContent = tr('工作区是干净的', 'Working tree is clean')

  const message = $('message').value.trim()
  const commit = $('commit')
  commit.textContent =
    staged.length > 0
      ? tr(`提交 ${staged.length} 个文件`, `Commit ${staged.length} files`)
      : changes.length > 0
        ? tr('暂存全部并提交', 'Stage all and commit')
        : tr('提交', 'Commit')
  commit.disabled = state.busy || !message || status.files.length === 0
  const generate = $('generate')
  generate.disabled = state.busy || state.generating || status.files.length === 0
  generate.classList.toggle('spinning', state.generating)
}

async function loadLog() {
  try {
    const { commits } = await api.call('git.log', { limit: 8 })
    const list = $('log')
    list.replaceChildren(
      ...commits.map((commit) => {
        const item = document.createElement('li')
        const hash = document.createElement('span')
        hash.className = 'hash'
        hash.textContent = commit.hash.slice(0, 7)
        const subject = document.createElement('span')
        subject.className = 'subject'
        subject.textContent = commit.subject
        subject.title = `${commit.subject}\n${commit.author}`
        const when = document.createElement('span')
        when.className = 'when'
        when.textContent = relativeTime(commit.date)
        item.append(hash, subject, when)
        return item
      })
    )
  } catch {
    $('log').replaceChildren()
  }
}

function relativeTime(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return tr('刚刚', 'just now')
  if (seconds < 3600)
    return tr(`${Math.floor(seconds / 60)} 分钟前`, `${Math.floor(seconds / 60)} min ago`)
  if (seconds < 86400)
    return tr(`${Math.floor(seconds / 3600)} 小时前`, `${Math.floor(seconds / 3600)} h ago`)
  if (seconds < 86400 * 30)
    return tr(`${Math.floor(seconds / 86400)} 天前`, `${Math.floor(seconds / 86400)} d ago`)
  return new Date(iso).toLocaleDateString()
}

let refreshing = null
async function refresh({ log = false } = {}) {
  if (refreshing) return refreshing
  state.loading = true
  render()
  refreshing = (async () => {
    try {
      state.status = await api.call('git.status', {})
      state.error = null
      if (state.open && !state.status.files.some((file) => file.path === state.open.path))
        state.open = null
      if (log || $('history').open) await loadLog()
    } catch (error) {
      state.status = null
      state.error =
        error && error.code === 'NOT_FOUND'
          ? /没有打开的项目|No project is open/.test(error.message || '')
            ? tr('打开项目后可查看改动', 'Open a project to see its changes')
            : tr('此项目不是 Git 仓库', "This project isn't a Git repository")
          : describeError(error) || tr('无法读取仓库状态', "Can't read the repository status")
    } finally {
      state.loading = false
      refreshing = null
      render()
    }
  })()
  return refreshing
}

/** Runs a write through the host, which asks the user according to the project's level. */
async function act(method, paths, params) {
  if (state.busy) return null
  state.busy = true
  showNotice(null)
  render()
  try {
    return await api.call(method, params || { paths })
  } catch (error) {
    const message = describeError(error)
    if (message) showNotice(message)
    return null
  } finally {
    state.busy = false
    state.epoch += 1
    await refresh({ log: true })
  }
}

async function commit() {
  const message = $('message').value.trim()
  const status = state.status
  if (!message || !status || state.busy) return
  const staged = status.files.some((file) => file.index !== ' ' && file.index !== '?')
  if (!staged) {
    const all = status.files.filter((file) => file.worktree !== ' ').map((file) => file.path)
    if (all.length === 0) return
    state.busy = true
    try {
      await api.call('git.stage', { paths: all })
    } catch (error) {
      state.busy = false
      const text = describeError(error)
      if (text) showNotice(text)
      await refresh()
      return
    }
    state.busy = false
  }
  const result = await act('git.commit', null, { message })
  if (result && result.hash) {
    $('message').value = ''
    showNotice(
      tr(`已提交 ${result.hash.slice(0, 7)}`, `Committed ${result.hash.slice(0, 7)}`),
      'info'
    )
    render()
  }
}

/** The diff a commit message is written from is cut here; the subject needs the gist. */
const MAX_DIFF_CHARS = 60000

const COMMIT_SYSTEM = [
  'You write git commit messages.',
  "Follow the style of the repository's recent commits: their language, prefixes such as",
  'feat: or fix:, and capitalization. Without recent commits, write a short imperative subject.',
  'The subject line is at most 72 characters. Add a blank line and a short body only when the',
  'change needs explaining; wrap it at 72 characters.',
  'Reply with the commit message only: no code fences, no quotes, no commentary.'
].join('\n')

/** Drops a code fence or quotes a model wraps the message in. */
function cleanMessage(text) {
  let body = text.trim()
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(body)
  if (fence) body = fence[1].trim()
  return body
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Writes a commit message from what will be committed: the staged changes, else all of them. */
async function generateMessage() {
  const status = state.status
  if (!status || state.busy || state.generating) return
  const staged = status.files.some((file) => file.index !== ' ' && file.index !== '?')
  const untracked = staged
    ? []
    : status.files.filter((file) => file.worktree === '?').map((file) => file.path)
  const before = $('message').value
  state.generating = true
  showNotice(null)
  render()
  try {
    const [{ patch }, recent] = await Promise.all([
      api.call('git.diff', { staged }),
      api.call('git.log', { limit: 10 }).catch(() => ({ commits: [] }))
    ])
    if (!patch.trim() && untracked.length === 0) {
      showNotice(tr('没有可用于生成的文本改动', 'No text changes to write a message from'))
      return
    }
    const diff =
      patch.length > MAX_DIFF_CHARS
        ? `${patch.slice(0, MAX_DIFF_CHARS)}\n[... diff truncated ...]`
        : patch
    const prompt = [
      recent.commits.length
        ? `Recent commits:\n${recent.commits.map((commit) => `- ${commit.subject}`).join('\n')}`
        : 'This repository has no commits yet.',
      before.trim() ? `The user's draft or hint for this message:\n${before.trim()}` : '',
      untracked.length ? `New files:\n${untracked.map((path) => `- ${path}`).join('\n')}` : '',
      `Changes to commit:\n${diff}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const result = await api.call('ai.complete', { system: COMMIT_SYSTEM, prompt, maxTokens: 400 })
    const message = cleanMessage(result.text)
    if (!message) {
      showNotice(tr('模型没有给出提交信息', 'The model gave no commit message'))
      return
    }
    // Typing while it was being written wins over the generated text.
    if ($('message').value !== before) return
    $('message').value = message
    $('message').focus()
    showNotice(
      tr(
        `由 ${result.model} 生成，请检查后提交`,
        `Written by ${result.model}; check it before committing`
      ),
      'info'
    )
  } catch (error) {
    const text = describeError(error)
    if (text) showNotice(text)
  } finally {
    state.generating = false
    render()
  }
}

async function push() {
  const result = await act('git.push', null, {})
  if (result)
    showNotice(
      tr(
        `已推送到 ${result.remote}/${result.branch}`,
        `Pushed to ${result.remote}/${result.branch}`
      ),
      'info'
    )
}

$('refresh').addEventListener('click', () => {
  state.epoch += 1
  refresh({ log: true })
})
$('push').addEventListener('click', push)
$('commit').addEventListener('click', commit)
$('generate').addEventListener('click', generateMessage)
$('stage-all').addEventListener('click', () => {
  const paths = (state.status?.files || []).filter((f) => f.worktree !== ' ').map((f) => f.path)
  if (paths.length) act('git.stage', paths)
})
$('unstage-all').addEventListener('click', () => {
  const paths = (state.status?.files || [])
    .filter((f) => f.index !== ' ' && f.index !== '?')
    .map((f) => f.path)
  if (paths.length) act('git.unstage', paths)
})
// On the phone there is no ⌘ key to mention.
if (api.surface === 'mobile') $('message').placeholder = tr('提交信息', 'Commit message')

$('message').addEventListener('input', render)
$('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    commit()
  }
})
$('history').addEventListener('toggle', () => {
  if ($('history').open) loadLog()
})

// Keep the panel current without flooding git: refresh on focus and every few seconds while shown.
window.addEventListener('focus', () => refresh())
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})
setInterval(() => {
  if (!document.hidden && !state.busy) refresh()
}, 4000)

api.onContext((context) => {
  if (context.projectPath !== state.project) {
    state.project = context.projectPath
    state.open = null
    $('message').value = ''
    showNotice(null)
  }
  refresh({ log: true })
})
api
  .getContext()
  .then((context) => {
    state.project = context.projectPath
  })
  .finally(() => refresh({ log: true }))
