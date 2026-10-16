import { ThemeProvider as NextThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

export const themeStorageKey = 'mkharness.theme';
export { useTheme } from 'next-themes';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      storageKey={themeStorageKey}
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
