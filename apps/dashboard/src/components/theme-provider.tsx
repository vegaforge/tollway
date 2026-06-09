"use client";

// next-themes provider for the dashboard. The web app gets this from Fumadocs'
// RootProvider; the dashboard wires it directly so the theme toggle and the
// .dark class behave the same way across both apps.

import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
