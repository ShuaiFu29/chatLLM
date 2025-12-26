import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThemeState {
  primaryColor: string;
  baseColor: string;
  setPrimaryColor: (color: string) => void;
  setBaseColor: (color: string) => void;
  applyTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      primaryColor: '#2563eb', // Default blue-600
      baseColor: '#111827', // Default gray-900 (Dark)

      setPrimaryColor: (color) => {
        set({ primaryColor: color });
        get().applyTheme();
      },

      setBaseColor: (color) => {
        set({ baseColor: color });
        get().applyTheme();
      },

      applyTheme: () => {
        const { primaryColor, baseColor } = get();
        const root = document.documentElement;

        // 1. Apply Primary Colors
        root.style.setProperty('--color-primary', primaryColor);
        root.style.setProperty('--color-primary-hover', adjustColorBrightness(primaryColor, -10));
        root.style.setProperty('--color-primary-light', adjustColorBrightness(primaryColor, 40));

        // 2. Apply Base/Background Colors (Auto-generated palette)
        // Determine if base is dark or light
        const isDark = isColorDark(baseColor);

        root.style.setProperty('--color-bg-base', baseColor);

        if (isDark) {
          // Dark Mode Palette
          root.style.setProperty('--color-bg-sidebar', adjustColorBrightness(baseColor, 5)); // Slightly lighter than base
          root.style.setProperty('--color-bg-surface', adjustColorBrightness(baseColor, 10)); // Lighter surface
          root.style.setProperty('--color-text-main', '#ffffff');
          root.style.setProperty('--color-text-muted', '#9ca3af'); // gray-400
          root.style.setProperty('--color-border', adjustColorBrightness(baseColor, 15));
        } else {
          // Light Mode Palette
          root.style.setProperty('--color-bg-sidebar', adjustColorBrightness(baseColor, -5)); // Slightly darker than base
          root.style.setProperty('--color-bg-surface', '#ffffff'); // White surface
          root.style.setProperty('--color-text-main', '#111827'); // gray-900
          root.style.setProperty('--color-text-muted', '#4b5563'); // gray-600
          root.style.setProperty('--color-border', adjustColorBrightness(baseColor, -15));
        }
      },
    }),
    {
      name: 'theme-storage',
      onRehydrateStorage: () => (state) => {
        state?.applyTheme();
      }
    }
  )
);

// Helper to determine if color is dark
function isColorDark(hex: string) {
  const c = hex.substring(1);      // strip #
  const rgb = parseInt(c, 16);   // convert rrggbb to decimal
  const r = (rgb >> 16) & 0xff;  // extract red
  const g = (rgb >> 8) & 0xff;  // extract green
  const b = (rgb >> 0) & 0xff;  // extract blue

  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b; // per ITU-R BT.709
  return luma < 128;
}

// Helper to adjust color brightness (hex)
function adjustColorBrightness(hex: string, percent: number) {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  return '#' + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
}
