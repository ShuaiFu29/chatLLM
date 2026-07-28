import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/useAuthStore';
import { useThemeStore } from './stores/useThemeStore';
import { useEffect, lazy, Suspense, useRef, useState } from 'react';
import ProtectedRoute from './components/ProtectedRoute';
import MainLayout from './layouts/MainLayout';
import Loading from './components/Loading';

import { Toaster } from 'sonner';

// Lazy load pages
const LoginPage = lazy(() => import('./pages/Login'));
const ChatPage = lazy(() => import('./pages/Chat'));
const ProfilePage = lazy(() => import('./pages/Profile'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));
const UsagePage = lazy(() => import('./pages/Usage'));
const PromptTemplatesPage = lazy(() => import('./pages/PromptTemplates'));
const RagEvaluationPage = lazy(() => import('./pages/RagEvaluation'));
const RetrievalLabPage = lazy(() => import('./pages/RetrievalLab'));
const GraphExplorerPage = lazy(() => import('./pages/GraphExplorer'));
const PersonaCenterPage = lazy(() => import('./pages/PersonaCenter'));

function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const applyTheme = useThemeStore((state) => state.applyTheme);
  const authInitializationStarted = useRef(false);
  const [oauthLoginSuccess] = useState(() => (
    new URLSearchParams(window.location.search).get('login') === 'success'
  ));

  useEffect(() => {
    if (!authInitializationStarted.current) {
      authInitializationStarted.current = true;
      if (oauthLoginSuccess) {
        window.history.replaceState({}, '', window.location.pathname);
      }
      void checkAuth(oauthLoginSuccess);
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
    
  }, [checkAuth, applyTheme, oauthLoginSuccess]);

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
              <Route path="/usage" element={<UsagePage />} />
              <Route path="/prompts" element={<PromptTemplatesPage />} />
              <Route path="/persona" element={<PersonaCenterPage />} />
              <Route path="/rag-eval" element={<RagEvaluationPage />} />
              <Route path="/retrieval-lab" element={<RetrievalLabPage />} />
              <Route path="/rag-graph" element={<GraphExplorerPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
