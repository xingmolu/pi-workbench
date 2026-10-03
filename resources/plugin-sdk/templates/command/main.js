// @ts-check
/** @type {PiDesktop.PluginModule} */
module.exports = {
  async onLoad() {
    // Shown in Settings → Desktop plugins → Logs.
    console.log('loaded')
    await pi.commands.register({
      id: 'hello',
      async run() {
        const { path } = await pi.project.current()
        await pi.ui.showToast(path ? `Hello from ${path}` : 'Hello! Open a project to see it here.')
      }
    })
  }
}
