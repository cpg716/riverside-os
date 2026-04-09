import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ModalProvider } from './context/ModalContext'
import ErrorBoundary from './components/ErrorBoundary'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ModalProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ModalProvider>
  </StrictMode>,
)
