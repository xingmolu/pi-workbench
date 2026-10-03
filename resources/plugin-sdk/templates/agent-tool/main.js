// @ts-check
/** @type {PiDesktop.PluginModule} */
module.exports = {
  async onLoad() {
    await pi.agent.registerTool({
      name: 'count_lines',
      // `input` already matches the `parameters` schema in pi-desktop.json.
      async run(input, context) {
        const { text } = await pi.fs.readText(input.path)
        const lines = text === '' ? 0 : text.split('\n').length
        context.log(`${input.path}: ${lines} lines`)
        return `${input.path} has ${lines} lines.`
      }
    })
  }
}
