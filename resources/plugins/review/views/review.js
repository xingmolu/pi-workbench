// Code review page for the bundled review plugin. Uses only the public plugin API
// (window.piPlugin); the code host's token stays in Pi Desktop.
'use strict'

const api = window.piPlugin
const $ = (id) => document.getElementById(id)
const english = api.locale === 'en'
const tr = (zh, en) => (english ? en : zh)

if (english) {
  document.documentElement.lang = 'en'
  $('list-pane').setAttribute('aria-label', 'Review list')
  $('refresh').setAttribute('aria-label', 'Refresh')
  $('refresh').title = 'Refresh'
}

/** Builds an element; strings become text nodes, never HTML. */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'text') node.textContent = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat())
    if (child !== null && child !== undefined && child !== false)
      node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child)
  return node
}

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
  loading: false
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

let noticeTimer = 0
function notice(message, kind = 'error') {
  const box = $('notice')
  if (!message) return void (box.hidden = true)
  box.textContent = message
  box.className = kind === 'info' ? 'notice is-info' : 'notice'
  box.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (box.hidden = true), kind === 'info' ? 4000 : 8000)
}

function relativeTime(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return tr('刚刚', 'just now')
  if (seconds < 3600)
    return tr(`${Math.floor(seconds / 60)} 分钟前`, `${Math.floor(seconds / 60)} min ago`)
  if (seconds < 86400)
    return tr(`${Math.floor(seconds / 3600)} 小时前`, `${Math.floor(seconds / 3600)} h ago`)
  return tr(`${Math.floor(seconds / 86400)} 天前`, `${Math.floor(seconds / 86400)} d ago`)
}

/** Splits a unified diff of many files into one entry per file. */
function parsePatch(patch) {
  const files = []
  let current = null
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0, lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) current.lines.push(line)
    else if (current.lines.length) {
      current.lines.push(line)
      if (line.startsWith('+')) current.additions++
      else if (line.startsWith('-')) current.deletions++
    } else if (line.startsWith('Binary files')) current.binary = true
  }
  return files.map((file) => ({ ...file, patch: file.lines.join('\n') }))
}

function diffView(file) {
  const box = el('details', {
    class: 'file',
    open: true,
    id: `file-${encodeURIComponent(file.path)}`
  })
  box.append(
    el(
      'summary',
      {},
      el('span', {
        class: 'file-path',
        text: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
      }),
      el(
        'span',
        { class: 'stat' },
        el('span', { class: 'add', text: `+${file.additions}` }),
        ' ',
        el('span', { class: 'del', text: `−${file.deletions}` })
      )
    )
  )
  if (!file.patch) {
    box.append(
      el('div', {
        class: 'note',
        text: file.binary
          ? tr('二进制文件', 'Binary file')
          : tr('没有可显示的文本差异', 'No text diff to show')
      })
    )
    return box
  }
  const pre = el('pre')
  for (const line of file.patch.split('\n').slice(0, 5000)) {
    if (line === '') continue
    pre.append(
      el('span', {
        class: line.startsWith('+')
          ? 'line add'
          : line.startsWith('-')
            ? 'line del'
            : line.startsWith('@@')
              ? 'line hunk'
              : 'line',
        text: line
      })
    )
  }
  box.append(pre)
  return box
}

/** File list and diffs side by side, for local changes and pull requests alike. */
function changesView(files) {
  if (!files.length) return el('div', { class: 'empty', text: tr('没有改动', 'No changes') })
  const tree = el(
    'ul',
    { class: 'file-list', 'aria-label': tr('改动的文件', 'Changed files') },
    files.map((file) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            title: file.path,
            onclick: () =>
              document
                .getElementById(`file-${encodeURIComponent(file.path)}`)
                ?.scrollIntoView({ block: 'start' })
          },
          el('span', { class: 'file-name', text: file.path.split('/').pop() }),
          el(
            'span',
            { class: 'stat' },
            el('span', { class: 'add', text: `+${file.additions}` }),
            el('span', { class: 'del', text: `−${file.deletions}` })
          )
        )
      )
    )
  )
  return el('div', { class: 'changes' }, tree, el('div', { class: 'diffs' }, files.map(diffView)))
}

function selected(kind, number) {
  const current = state.selection
  return current.kind === kind && (number === undefined || current.number === number)
}

function listItem({ kind, number, title, meta, badge }) {
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
        onclick: () => select({ kind, number })
      },
      el('span', { class: 'item-title', text: title }),
      el(
        'span',
        { class: 'item-meta' },
        meta,
        badge ? el('span', { class: 'badge', text: badge }) : null
      )
    )
  )
}

function renderList() {
  const repo = state.repo
  $('repo').textContent =
    repo && repo.owner ? `${repo.owner}/${repo.repo}` : tr('本地仓库', 'Local repository')
  $('refresh').classList.toggle('spinning', state.loading)
  const account = $('account')
  account.replaceChildren()
  if (repo && repo.reason) {
    account.hidden = false
    account.append(el('p', { text: repo.reason }))
    if (repo.provider === 'github' && !repo.viewer)
      account.append(
        el('button', {
          type: 'button',
          class: 'link',
          text: tr('去设置登录 GitHub', 'Sign in to GitHub in Settings'),
          onclick: () => api.call('ui.openSettings', { section: 'forges' })
        })
      )
  } else account.hidden = true

  const sections = []
  const local = []
  const files = state.status ? state.status.files.length : 0
  local.push(
    listItem({
      kind: 'working',
      title: tr('未提交的改动', 'Uncommitted changes'),
      meta: state.status
        ? tr(`${files} 个文件`, `${files} files`)
        : state.localError || tr('读取中…', 'Loading…')
    })
  )
  if (state.outgoing && state.outgoing.commits.length)
    local.push(
      listItem({
        kind: 'outgoing',
        title: tr('未推送的提交', 'Unpushed commits'),
        meta: `${state.outgoing.branch || 'HEAD'} → ${state.outgoing.base}`,
        badge: String(state.outgoing.commits.length + state.outgoing.moreCommits)
      })
    )
  sections.push(group(tr('本地', 'Local'), local))
  if (state.pulls) {
    const pullItems = (pulls) =>
      pulls.map((pull) =>
        listItem({
          kind: 'pull',
          number: pull.number,
          title: pull.title,
          meta: `#${pull.number} · ${pull.author} · ${relativeTime(pull.updatedAt)}`,
          badge: pull.draft ? tr('草稿', 'Draft') : null
        })
      )
    sections.push(
      group(
        tr('我创建的', 'Created by me'),
        pullItems(state.pulls.mine),
        tr('没有打开的拉取请求', 'No open pull requests')
      )
    )
    sections.push(
      group(
        tr('待我审查', 'Waiting for my review'),
        pullItems(state.pulls.reviewRequested),
        tr('没有待审查的', 'Nothing to review')
      )
    )
    if (state.pulls.others.length)
      sections.push(group(tr('其他打开的', 'Other open'), pullItems(state.pulls.others)))
  } else if (state.pullsError)
    sections.push(el('p', { class: 'list-note', text: state.pullsError }))
  $('sections').replaceChildren(...sections)
}

function group(title, items, empty) {
  return el(
    'section',
    { class: 'group' },
    el('h2', { text: title }),
    items.length ? el('ul', {}, items) : el('p', { class: 'list-note', text: empty || '' })
  )
}

function actionButton(label, onclick, options = {}) {
  return el('button', {
    type: 'button',
    class: options.primary ? 'primary' : 'secondary',
    disabled: state.busy || options.disabled,
    onclick,
    text: label
  })
}

async function run(task, success) {
  if (state.busy) return
  state.busy = true
  renderDetail()
  try {
    const result = await task()
    if (success) notice(success, 'info')
    return result
  } catch (error) {
    const message = describeError(error)
    if (message) notice(message)
  } finally {
    state.busy = false
    renderDetail()
  }
}

function reviewWithPi(text) {
  return run(() => api.call('chat.draft', { text }))
}

function workingDetail() {
  const status = state.status
  if (!status)
    return el('div', { class: 'empty', text: state.localError || tr('读取中…', 'Loading…') })
  const head = el(
    'header',
    { class: 'detail-head' },
    el('h1', { text: tr('未提交的改动', 'Uncommitted changes') }),
    el('p', {
      class: 'meta',
      text: status.branch ? tr(`分支 ${status.branch}`, `Branch ${status.branch}`) : ''
    }),
    el(
      'div',
      { class: 'actions' },
      actionButton(
        tr('用 Pi 审查', 'Review with Pi'),
        () =>
          reviewWithPi(
            tr(
              '请审查当前项目里未提交的改动（用 git status、git diff 和 git diff --cached 查看）。重点找正确性问题、遗漏的边界情况和缺少的测试，按严重程度列出发现并引用文件和行号。先不要修改文件。',
              'Review the uncommitted changes in this project (see git status, git diff and git diff --cached). Look for correctness bugs, missed edge cases and missing tests; list findings by severity with file and line references. Do not change any files yet.'
            )
          ),
        { primary: true, disabled: !status.files.length }
      ),
      actionButton(
        tr('全部暂存', 'Stage all'),
        () =>
          run(
            () => api.call('git.stage', { paths: status.files.map((file) => file.path) }),
            tr('已暂存', 'Staged')
          ).then(refreshLocal),
        { disabled: !status.files.length }
      )
    )
  )
  const compose = el(
    'form',
    {
      class: 'compose',
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
    el('button', {
      type: 'submit',
      class: 'secondary',
      disabled: state.busy,
      text: tr('提交', 'Commit')
    })
  )
  const container = el(
    'div',
    { class: 'detail-body' },
    compose,
    el('div', { id: 'working-diff', class: 'note', text: tr('正在加载差异…', 'Loading diff…') })
  )
  loadWorkingDiff()
  return [head, container]
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
    const untracked = (state.status?.files || []).filter((file) => file.index === '?')
    for (const file of untracked)
      files.push({ path: file.path, additions: 0, deletions: 0, patch: '', untracked: true })
    $('working-diff')?.replaceWith(changesView(files))
  } catch (error) {
    if (token === workingDiffToken) $('working-diff')?.replaceChildren(describeError(error) || '')
  }
}

function outgoingDetail() {
  const outgoing = state.outgoing
  if (!outgoing) return el('div', { class: 'empty', text: tr('读取中…', 'Loading…') })
  const total = outgoing.commits.length + outgoing.moreCommits
  return [
    el(
      'header',
      { class: 'detail-head' },
      el('h1', { text: tr('未推送的提交', 'Unpushed commits') }),
      el('p', {
        class: 'meta',
        text: tr(
          `${outgoing.branch} 比 ${outgoing.base} 多 ${total} 个提交`,
          `${outgoing.branch} is ${total} commits ahead of ${outgoing.base}`
        )
      }),
      el(
        'div',
        { class: 'actions' },
        actionButton(
          tr('用 Pi 审查', 'Review with Pi'),
          () =>
            reviewWithPi(
              tr(
                `请审查分支 ${outgoing.branch} 上还没推送的提交（git log ${outgoing.base}..HEAD，git diff ${outgoing.base}...HEAD）。重点找正确性问题、遗漏的边界情况和缺少的测试，按严重程度列出发现并引用文件和行号。先不要修改文件。`,
                `Review the unpushed commits on ${outgoing.branch} (git log ${outgoing.base}..HEAD, git diff ${outgoing.base}...HEAD). Look for correctness bugs, missed edge cases and missing tests; list findings by severity with file and line references. Do not change any files yet.`
              )
            ),
          { primary: true }
        ),
        actionButton(tr('推送', 'Push'), () =>
          run(() => api.call('git.push', {}), tr('已推送', 'Pushed')).then(refreshLocal)
        )
      )
    ),
    el(
      'div',
      { class: 'detail-body' },
      el(
        'ol',
        { class: 'commits' },
        outgoing.commits.map((commit) =>
          el(
            'li',
            {},
            el('code', { text: commit.hash.slice(0, 7) }),
            el('span', { text: commit.subject }),
            el('small', { text: `${commit.author} · ${relativeTime(commit.date)}` })
          )
        )
      ),
      changesView(parsePatch(outgoing.patch))
    )
  ]
}

const CONCLUSION = {
  success: ['ok', tr('通过', 'Passed')],
  failure: ['bad', tr('失败', 'Failed')],
  cancelled: ['muted', tr('已取消', 'Cancelled')],
  skipped: ['muted', tr('跳过', 'Skipped')],
  neutral: ['muted', tr('中性', 'Neutral')],
  timed_out: ['bad', tr('超时', 'Timed out')],
  action_required: ['warn', tr('需要处理', 'Action required')]
}

function checkRow(check) {
  const [tone, label] =
    check.status !== 'completed'
      ? ['warn', check.status === 'in_progress' ? tr('运行中', 'Running') : tr('排队中', 'Queued')]
      : CONCLUSION[check.conclusion] || ['muted', check.conclusion || '']
  return el(
    'li',
    {},
    el('span', { class: `dot is-${tone}`, 'aria-hidden': 'true' }),
    el('span', { text: check.name }),
    el('small', { text: label })
  )
}

function mergeStatus(pull) {
  if (pull.state !== 'open')
    return pull.state === 'merged' ? tr('已合并', 'Merged') : tr('已关闭', 'Closed')
  if (pull.mergeable === null)
    return tr('GitHub 正在计算能否合并…', 'GitHub is still checking mergeability…')
  if (!pull.mergeable) return tr('有合并冲突', 'Has merge conflicts')
  if (pull.mergeableState === 'blocked')
    return tr('可合并，但被分支保护规则阻止', 'Mergeable, but blocked by branch protection')
  if (pull.mergeableState === 'unstable')
    return tr('可合并，但有检查没通过', 'Mergeable, but some checks are failing')
  return tr('可以合并，没有冲突', 'Can merge without conflicts')
}

function pullDetail(number) {
  const loaded = state.detail && state.detail.number === number ? state.detail : null
  if (!loaded) return el('div', { class: 'empty', text: tr('读取中…', 'Loading…') })
  if (loaded.error) return el('div', { class: 'empty', text: loaded.error })
  const pull = loaded.data
  const prompt = tr(
    `请审查拉取请求 #${pull.number}「${pull.title}」（${pull.headRef} → ${pull.baseRef}，${pull.url}）。先用 git fetch origin pull/${pull.number}/head 取到它的提交，再用 git diff origin/${pull.baseRef}...FETCH_HEAD 查看改动。重点找正确性问题、遗漏的边界情况和缺少的测试，按严重程度列出发现并引用文件和行号，最后整理成可以直接发到这个拉取请求上的评论。不要修改文件，也不要推送。`,
    `Review pull request #${pull.number} "${pull.title}" (${pull.headRef} → ${pull.baseRef}, ${pull.url}). Fetch it with git fetch origin pull/${pull.number}/head, then read git diff origin/${pull.baseRef}...FETCH_HEAD. Look for correctness bugs, missed edge cases and missing tests; list findings by severity with file and line references, and finish with a comment ready to post on the pull request. Do not change files or push.`
  )
  const method = el(
    'select',
    { 'aria-label': tr('合并方式', 'Merge method') },
    el('option', { value: 'merge', text: tr('合并提交', 'Merge commit') }),
    el('option', { value: 'squash', text: tr('压缩合并', 'Squash') }),
    el('option', { value: 'rebase', text: tr('变基合并', 'Rebase') })
  )
  const head = el(
    'header',
    { class: 'detail-head' },
    el('h1', {}, pull.title, ' ', el('span', { class: 'number', text: `#${pull.number}` })),
    el('p', {
      class: 'meta',
      text: `${pull.author} · ${pull.headRef} → ${pull.baseRef} · ${relativeTime(pull.updatedAt)}`
    }),
    el(
      'div',
      { class: 'actions' },
      actionButton(tr('用 Pi 审查', 'Review with Pi'), () => reviewWithPi(prompt), {
        primary: true
      }),
      actionButton(tr('在 GitHub 打开', 'Open on GitHub'), () =>
        api.call('shell.openExternal', { url: pull.url })
      ),
      pull.state === 'open'
        ? el(
            'span',
            { class: 'merge' },
            method,
            actionButton(
              tr('合并', 'Merge'),
              () =>
                run(
                  () =>
                    api.call('forge.merge', {
                      number: pull.number,
                      method: method.value,
                      headSha: pull.headSha
                    }),
                  tr('已合并', 'Merged')
                ).then(() => {
                  loadPull(pull.number)
                  loadPulls()
                }),
              { disabled: pull.mergeable === false || pull.draft }
            )
          )
        : null
    ),
    el(
      'div',
      { class: 'tabs', role: 'tablist' },
      ['summary', 'changes'].map((tab) =>
        el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(state.tab === tab),
          class: state.tab === tab ? 'tab is-active' : 'tab',
          onclick: () => {
            state.tab = tab
            renderDetail()
          },
          text:
            tab === 'summary'
              ? tr('概要', 'Summary')
              : tr(
                  `改动 +${pull.additions} −${pull.deletions}`,
                  `Changes +${pull.additions} −${pull.deletions}`
                )
        })
      )
    )
  )
  if (state.tab === 'changes') {
    const files = state.files && state.files.number === number ? state.files : null
    if (!files) loadFiles(number)
    return [
      head,
      el(
        'div',
        { class: 'detail-body' },
        !files
          ? el('div', { class: 'note', text: tr('正在加载改动…', 'Loading changes…') })
          : files.error
            ? el('div', { class: 'note', text: files.error })
            : changesView(files.data)
      )
    ]
  }
  const side = el(
    'aside',
    { class: 'facts' },
    el('h3', { text: tr('合并状态', 'Merge status') }),
    el('p', { text: mergeStatus(pull) }),
    pull.stack.length
      ? [
          el('h3', { text: tr('叠加的拉取请求', 'Stack') }),
          el(
            'ol',
            { class: 'stack' },
            pull.stack.map((item) =>
              el(
                'li',
                { class: item.current ? 'is-current' : '' },
                el('button', {
                  type: 'button',
                  class: 'link',
                  disabled: item.current,
                  onclick: () => select({ kind: 'pull', number: item.number }),
                  text: `#${item.number} ${item.title}`
                })
              )
            )
          )
        ]
      : null,
    el('h3', { text: tr('审查', 'Reviews') }),
    pull.reviews.length
      ? el(
          'ul',
          { class: 'plain' },
          pull.reviews.map((review) =>
            el('li', { text: `${review.author} · ${review.state.toLowerCase().replace('_', ' ')}` })
          )
        )
      : el('p', { class: 'muted', text: tr('还没有审查', 'No reviews yet') }),
    el('h3', { text: tr('检查', 'Checks') }),
    pull.checks.length
      ? el('ul', { class: 'checks' }, pull.checks.map(checkRow))
      : el('p', { class: 'muted', text: tr('没有检查', 'No checks') })
  )
  const comment = el(
    'form',
    {
      class: 'compose',
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
        'Write a comment; paste Pi’s review here (you confirm before it is posted)'
      ),
      'aria-label': tr('评论', 'Comment')
    }),
    el('button', {
      type: 'submit',
      class: 'secondary',
      disabled: state.busy,
      text: tr('发表评论', 'Comment')
    })
  )
  return [
    head,
    el(
      'div',
      { class: 'detail-body summary' },
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'description', text: pull.body || tr('没有描述。', 'No description.') }),
        comment
      ),
      side
    )
  ]
}

function renderDetail() {
  const selection = state.selection
  const content =
    selection.kind === 'working'
      ? workingDetail()
      : selection.kind === 'outgoing'
        ? outgoingDetail()
        : pullDetail(selection.number)
  $('detail').replaceChildren(...[content].flat())
}

function select(selection) {
  state.selection = selection
  state.tab = 'summary'
  renderList()
  renderDetail()
  if (selection.kind === 'pull' && !(state.detail && state.detail.number === selection.number))
    loadPull(selection.number)
}

async function loadPull(number) {
  try {
    const data = await api.call('forge.pull', { number })
    state.detail = { number, data }
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
    const data = await api.call('forge.pullFiles', { number })
    state.files = { number, data }
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
    state.status = status
    state.outgoing = outgoing
    state.localError = null
  } catch (error) {
    state.status = null
    state.outgoing = null
    state.localError = describeError(error)
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

$('refresh').addEventListener('click', () => refresh())
let project = null
api.onContext((context) => {
  if (context.projectPath === project) return
  project = context.projectPath
  state.detail = null
  state.files = null
  state.selection = { kind: 'working' }
  refresh()
})
api
  .getContext()
  .then((context) => (project = context.projectPath))
  .finally(() => refresh())
renderDetail()
