import { createContext } from 'react';

export interface NavigationLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface NavigationContextValue {
  location: NavigationLocation;
  navigate: (target: string, options?: { replace?: boolean }) => void;
}

export const NavigationContext = createContext<NavigationContextValue | null>(null);

export const currentNavigationLocation = (): NavigationLocation => ({
  pathname: window.location.pathname,
  search: window.location.search,
  hash: window.location.hash,
});
