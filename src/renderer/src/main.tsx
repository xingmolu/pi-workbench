import './assets/main.css'
import './assets/theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useDesktopSettings } from './store/desktop-settings'
import { applyDocumentTheme, resolveTheme, systemIsDark } from './store/theme'

void useDesktopSettings
  .getState()
  .hydrate()
  .then(() => {
    applyDocumentTheme(resolveTheme(useDesktopSettings.getState().settings.theme, systemIsDark()))
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
