import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/useAuthStore';
import { useThemeStore } from './stores/useThemeStore';
import { useEffect, lazy, Suspense, useState } from 'react';
import ProtectedRoute from './components/ProtectedRoute';
import MainLayout from './layouts/MainLayout';
import Loading from './components/Loading';

import { Toaster } from 'sonner';

// Lazy load pages
const LoginPage = lazy(() => import('./pages/Login'));
const ChatPage = lazy(() => import('./pages/Chat'));
const ProfilePage = lazy(() => import('./pages/Profile'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));

function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const applyTheme = useThemeStore((state) => state.applyTheme);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check for login success param from OAuth callback
    const params = new URLSearchParams(window.location.search);
    const loginSuccess = params.get('login') === 'success';

    if (loginSuccess) {
      // Clear the param from URL without refreshing
      window.history.replaceState({}, '', window.location.pathname);
      checkAuth(true); // Force check
    } else {
      checkAuth(); // Normal check (respects localStorage)
    }

    applyTheme(); // Ensure theme is applied on app mount

    // Remove static loader from index.html
    const staticLoader = document.getElementById('app-loading');
    if (staticLoader) {
      staticLoader.style.opacity = '0';
      setTimeout(() => {
        staticLoader.remove();
      }, 500);
    }
    
    // Simulate minimum loading time for better UX and preload resources
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 1500);

    return () => clearTimeout(timer);
  }, [checkAuth, applyTheme]);

  if (isLoading) {
    return <Loading />;
  }

  return (
    <BrowserRouter>
      <Toaster position="top-center" richColors />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<MainLayout />}>
              <Route path="/" element={<ChatPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/knowledge" element={<KnowledgeBase />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
