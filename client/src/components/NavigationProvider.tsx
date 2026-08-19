import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  currentNavigationLocation,
  NavigationContext,
} from '../lib/navigationContext';
import { requireInternalPath } from '../lib/navigation';

export default function NavigationProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(currentNavigationLocation);

  useEffect(() => {
    const handlePopState = () => setLocation(currentNavigationLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((target: string, options?: { replace?: boolean }) => {
    const safeTarget = requireInternalPath(target);
    if (options?.replace) {
      window.history.replaceState({}, '', safeTarget);
    } else {
      window.history.pushState({}, '', safeTarget);
    }
    setLocation(currentNavigationLocation());
  }, []);

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}
