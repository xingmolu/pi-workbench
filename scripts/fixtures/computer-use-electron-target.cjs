const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 500,
    height: 360,
    title: 'PI_CU_ELECTRON_TARGET',
    webPreferences: { sandbox: true }
  })
  const sidebar = Array.from(
    { length: 8 },
    (_, group) =>
      '<div role="group" aria-label="sidebar group">' +
      Array.from({ length: 10 }, (_, item) => `<button>SIDEBAR_${group}_${item}</button>`).join(
        ''
      ) +
      '</div>'
  ).join('')
  const content =
    '<div role="group" aria-label="fixture layer">'.repeat(8) +
    sidebar +
    '<button>CU_ELECTRON_DEEP_BUTTON</button><input aria-label="CU_ELECTRON_DEEP_INPUT">' +
    '</div>'.repeat(8)
  window.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent('<title>PI_CU_ELECTRON_TARGET</title>' + content)
  )
  window.show()
  window.focus()
})
app.on('window-all-closed', () => app.quit())
