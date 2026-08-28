import { useAuthStore } from './stores/useAuthStore';
import { useThemeStore } from './stores/useThemeStore';
import { useEffect, lazy, Suspense, useRef, useState } from 'react';
import ProtectedRoute from './components/ProtectedRoute';
import MainLayout from './layouts/MainLayout';
import Loading from './components/Loading';
import Navigate from './components/Navigate';
import NavigationProvider from './components/NavigationProvider';
import { normalizeRoutePath, useLocation } from './lib/navigation';

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
const AgentsPage = lazy(() => import('./pages/Agents'));
const AgentMemoriesPage = lazy(() => import('./pages/AgentMemories'));

const authenticatedPages: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  '/': ChatPage,
  '/profile': ProfilePage,
  '/knowledge': KnowledgeBase,
  '/usage': UsagePage,
  '/prompts': PromptTemplatesPage,
  '/persona': PersonaCenterPage,
  '/agents': AgentsPage,
  '/agent-memories': AgentMemoriesPage,
  '/rag-eval': RagEvaluationPage,
  '/retrieval-lab': RetrievalLabPage,
  '/rag-graph': GraphExplorerPage,
};

function AppRoutes() {
  const { pathname } = useLocation();
  // Route keys are matched exactly, so normalize before the lookup: without it
  // a bookmarked `/knowledge/` redirected to the chat page.
  const route = normalizeRoutePath(pathname);
  if (route === '/login') return <LoginPage />;

  const Page = authenticatedPages[route];
  if (!Page) return <Navigate to="/" replace />;

  return (
    <ProtectedRoute>
      <MainLayout>
        <Page />
      </MainLayout>
    </ProtectedRoute>
  );
}

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
    <NavigationProvider>
      <Toaster position="top-center" richColors />
      <Suspense fallback={<Loading />}>
        <AppRoutes />
      </Suspense>
    </NavigationProvider>
  );
}

export default App;
