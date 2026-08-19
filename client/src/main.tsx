import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './i18n'; // Import i18n configuration
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';

// Register Service Worker
// @ts-expect-error - virtual module
import { registerSW } from 'virtual:pwa-register';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onNeedRefresh() {},
    onOfflineReady() {},
  });
} else if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => (
    Promise.all(registrations.map((registration) => registration.unregister()))
  ));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
