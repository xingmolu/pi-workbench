// @ts-check
const { scan } = require('./scan')

/** @type {PiDesktop.PluginModule} */
module.exports = {
  async onLoad() {
    await pi.commands.register({ id: 'open', run: () => pi.ui.openView('list') })

    await pi.agent.registerTool({
      name: 'list_todos',
      async run(input, context) {
        const todos = (await scan()).filter((todo) => !input.tag || todo.tag === input.tag)
        context.log(`found ${todos.length}`)
        if (todos.length === 0) return 'No TODO or FIXME comments.'
        return todos.map((todo) => `${todo.path}:${todo.line} ${todo.tag} ${todo.text}`).join('\n')
      }
    })
  },

  /** The panel asks the process to scan, so both share one implementation. */
  async onPanelInvoke(channel) {
    if (channel === 'todos.scan') return scan()
    throw new Error(`Unknown channel ${channel}`)
  }
}
