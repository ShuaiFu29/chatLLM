import { useCallback, useContext } from 'react';
import { NavigationContext } from './navigationContext';

export const requireInternalPath = (target: string) => {
  if (!target.startsWith('/') || target.startsWith('//')) {
    throw new Error('Navigation target must be an origin-relative path');
  }
  return target;
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
