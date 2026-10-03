// @ts-check
const en = window.piPlugin.locale === 'en'
const list = /** @type {HTMLOListElement} */ (document.getElementById('todos'))
const summary = /** @type {HTMLElement} */ (document.getElementById('summary'))
const refresh = /** @type {HTMLButtonElement} */ (document.getElementById('refresh'))
refresh.textContent = en ? 'Refresh' : '刷新'

/** @param {{ path: string; line: number; tag: string; text: string }} todo */
function item(todo) {
  const li = document.createElement('li')
  const tag = document.createElement('span')
  tag.className = 'tag'
  tag.textContent = todo.tag
  const where = document.createElement('div')
  where.className = 'where'
  where.textContent = `${todo.path}:${todo.line}`
  li.append(tag, todo.text || '—', where)
  return li
}

async function load() {
  const { base } = await window.piPlugin.call('app.getAppearance')
  document.documentElement.dataset.theme = base
  summary.textContent = en ? 'Scanning…' : '正在查找…'
  try {
    // Not a host method: the plugin process answers it in `onPanelInvoke`.
    const todos = /** @type {any[]} */ (await window.piPlugin.call('todos.scan'))
    list.replaceChildren(...todos.map(item))
    summary.textContent = en ? `${todos.length} found` : `找到 ${todos.length} 条`
  } catch (error) {
    summary.textContent = /** @type {PiDesktop.ApiError} */ (error).message
  }
}

refresh.addEventListener('click', () => void load())
window.piPlugin.onContext(() => void load())
void load()
