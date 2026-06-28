import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './i18n'; // Import i18n configuration
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';

// Register Service Worker
// @ts-expect-error - virtual module
import { registerSW } from 'virtual:pwa-register';

if ('serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onNeedRefresh() {},
    onOfflineReady() {},
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
