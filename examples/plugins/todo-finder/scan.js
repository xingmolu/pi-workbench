// @ts-check
/** @typedef {{ path: string; line: number; tag: string; text: string }} Todo */

const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage'])
const TEXT =
  /\.(c|cc|cpp|cs|css|go|h|html|java|js|jsx|kt|md|mjs|py|rb|rs|scss|sh|swift|ts|tsx|vue|ya?ml)$/i
const MAX_FILES = 400
const MAX_TODOS = 500

/**
 * Walks the open project through `pi.fs` and collects TODO and FIXME comments.
 * `pi.fs` only reaches the open project, so this cannot read anything else.
 * @returns {Promise<Todo[]>}
 */
async function scan() {
  /** @type {Todo[]} */
  const todos = []
  const queue = ['.']
  let files = 0
  while (queue.length > 0 && files < MAX_FILES && todos.length < MAX_TODOS) {
    const directory = /** @type {string} */ (queue.shift())
    const { entries } = await pi.fs.list(directory)
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = directory === '.' ? entry.name : `${directory}/${entry.name}`
      if (entry.kind === 'directory' && !SKIP.has(entry.name)) queue.push(path)
      if (entry.kind !== 'file' || !TEXT.test(entry.name)) continue
      files += 1
      let text
      try {
        ;({ text } = await pi.fs.readText(path))
      } catch {
        continue // Too large or not UTF-8.
      }
      text.split('\n').forEach((line, index) => {
        const match = /\b(TODO|FIXME)\b[:\s]*(.*)/.exec(line)
        if (match && todos.length < MAX_TODOS)
          todos.push({ path, line: index + 1, tag: match[1], text: match[2].trim().slice(0, 200) })
      })
    }
  }
  return todos
}

module.exports = { scan }
