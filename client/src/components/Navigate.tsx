import { useEffect } from 'react';
import { useNavigate } from '../lib/navigation';

export default function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}
