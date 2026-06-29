import { useAuthStore } from '../stores/useAuthStore';
import { Navigate, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function ProtectedRoute() {
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);
  const { t } = useTranslation();

  if (loading) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white">{t('common.loading')}</div>;

  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
