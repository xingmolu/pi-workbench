import './assets/main.css'
import './assets/theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useDesktopSettings } from './store/desktop-settings'
import { applyDocumentTheme, resolveTheme, systemIsDark } from './store/theme'
import { languageTag } from '../../shared/i18n'

document.documentElement.lang = languageTag()

void useDesktopSettings
  .getState()
  .hydrate()
  .then(() => {
    const { settings } = useDesktopSettings.getState()
    applyDocumentTheme(resolveTheme(settings.theme, systemIsDark()))
    document.documentElement.dataset.accent = settings.accent
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
