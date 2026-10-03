// @ts-check
const notesInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('notes'))
const statusLine = /** @type {HTMLElement} */ (document.getElementById('status'))
const projectName = /** @type {HTMLElement} */ (document.getElementById('project'))
const en = window.piPlugin.locale === 'en'

let saveTimer = 0

/** Shows the open project and its notes. Runs again when the project changes. */
async function load() {
  const { base } = await window.piPlugin.call('app.getAppearance')
  document.documentElement.dataset.theme = base
  const workspace = await window.piPlugin.call('workspace.get')
  projectName.textContent = workspace ? workspace.name : ''
  // Storage is kept per plugin and per project.
  const saved = await window.piPlugin.call('storage.get', { key: 'notes' })
  notesInput.value = typeof saved === 'string' ? saved : ''
  statusLine.textContent = ''
}

notesInput.addEventListener('input', () => {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    try {
      await window.piPlugin.call('storage.set', { key: 'notes', value: notesInput.value })
      statusLine.textContent = en ? 'Saved' : '已保存'
    } catch (error) {
      // Host calls reject with { code, message }.
      statusLine.textContent = /** @type {PiDesktop.ApiError} */ (error).message
    }
  }, 400)
})

window.piPlugin.onContext(() => void load())
void load()
