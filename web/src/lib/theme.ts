// Light or dark, from the HSL Suite kit: stored under one key for every HackSpaceLabs app and applied as
// data-theme="dark" on <html>. Light unless the user turns dark on; never follows the operating system.
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const getTheme = (): Theme => window.HSLSuite.theme.get();
export const setTheme = (t: Theme) => { window.HSLSuite.theme.set(t); };

export function useTheme(): Theme {
  const [theme, set] = useState<Theme>(getTheme);
  useEffect(() => {
    const on = () => set(getTheme());
    document.addEventListener('hsl-themechange', on);
    return () => document.removeEventListener('hsl-themechange', on);
  }, []);
  return theme;
}
