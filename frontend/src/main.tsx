import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './api/queryClient'
import WorkbenchModeProvider from './components/layout/WorkbenchModeProvider'
import App from './App'
import './styles/tokens.css'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* 工作台模式挂在最外层：连整屏脱离外壳的漫画阅读器也在
            这套上下文里，模式切到哪一侧由 URL 路径决定。 */}
        <WorkbenchModeProvider>
          <App />
        </WorkbenchModeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
