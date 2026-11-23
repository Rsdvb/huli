import '@renderer/styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initSettings } from '@renderer/stores/settings'
import { initThemes } from '@renderer/stores/themes'
import { MiniWindow } from './mini-window'

// As the window does, the first render waits for the language, the text size and the colors.
Promise.all([initSettings(), initThemes()])
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <MiniWindow />
      </StrictMode>,
    ),
  )
  .catch((error: unknown) => console.error('The mini window could not start', error))
