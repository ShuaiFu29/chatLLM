import { Github } from 'lucide-react';
import { useAuthStore } from '../stores/useAuthStore';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function LoginPage() {
  const login = useAuthStore((state) => state.login);
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);
  const { t } = useTranslation();

  if (loading) return <div>Loading...</div>;
  if (user) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center p-4 transition-colors duration-300">
      <div className="bg-bg-sidebar p-8 rounded-xl shadow-2xl max-w-md w-full text-center border border-border">
        <h1 className="text-4xl font-bold text-text-main mb-2">{t('auth.loginTitle')}</h1>
        <p className="text-text-muted mb-8">{t('auth.loginSubtitle')}</p>

        <div className="space-y-4">
          <button
            onClick={login}
            className="w-full bg-bg-surface hover:bg-bg-base text-text-main font-semibold py-3 px-4 rounded-lg flex items-center justify-center gap-3 transition-colors duration-200 border border-border hover:border-primary"
          >
            <Github className="w-5 h-5" />
            {t('auth.signInWithGithub')}
          </button>

          <p className="text-xs text-text-muted mt-4">
            {t('auth.agreement')}
          </p>

          <div className="pt-2 border-t border-border mt-4">
            <a 
              href="https://github.com/logout" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-primary hover:text-primary-dark transition-colors"
            >
              {t('auth.switchAccount') || 'Switch GitHub Account'}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
