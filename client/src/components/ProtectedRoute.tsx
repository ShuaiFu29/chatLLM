import { useAuthStore } from '../stores/useAuthStore';
import { Navigate, Outlet } from 'react-router-dom';

export default function ProtectedRoute() {
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);

  if (loading) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white">Loading...</div>;

  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
