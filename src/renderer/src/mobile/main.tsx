import './mobile.css'

import { createRoot } from 'react-dom/client'
import { MobileApp } from './MobileApp'
import { applyStoredTheme } from './theme'

applyStoredTheme()
createRoot(document.getElementById('app')!).render(<MobileApp />)
