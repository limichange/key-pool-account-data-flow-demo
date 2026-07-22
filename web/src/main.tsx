import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@xyflow/react/dist/style.css'
import './styles/theme.css'
import './components/ui.css'
import './nodes/nodes.css'
import './edges/edges.css'
import './canvas/canvas.css'
import './panels/panels.css'
import './styles/app.css'

import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
