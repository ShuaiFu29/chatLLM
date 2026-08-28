import { useCallback, useContext } from 'react';
import { NavigationContext } from './navigationContext';

export const requireInternalPath = (target: string) => {
  if (!target.startsWith('/') || target.startsWith('//')) {
    throw new Error('Navigation target must be an origin-relative path');
  }
  return target;
};

/**
 * Canonical form of a pathname for route lookup.
 *
 * The route table is matched by exact string, so `/knowledge/` and `/Knowledge`
 * fell through to the catch-all redirect and bounced the user back to the chat
 * page. Trailing slashes and casing are not meaningful in these routes, so
 * normalize them instead of adding duplicate table entries. The root path stays
 * `/`.
 */
export const normalizeRoutePath = (pathname: string) => {
  const withoutTrailingSlashes = pathname.replace(/\/+$/, '');
  return (withoutTrailingSlashes || '/').toLowerCase();
};

const useNavigation = () => {
  const context = useContext(NavigationContext);
  if (!context) throw new Error('Navigation hooks require NavigationProvider');
  return context;
};

export const useLocation = () => useNavigation().location;
export const useNavigate = () => {
  const { navigate } = useNavigation();
  return useCallback(
    (target: string, options?: { replace?: boolean }) => navigate(target, options),
    [navigate],
  );
};
