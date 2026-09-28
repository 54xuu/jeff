import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

if (import.meta.env.DEV && new URLSearchParams(location.search).get('fixture') === 'markdown') {
  void import('./markdown-fixture').then(({ MarkdownFixture }) => {
    root.render(
      <StrictMode>
        <MarkdownFixture />
      </StrictMode>,
    )
  })
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
