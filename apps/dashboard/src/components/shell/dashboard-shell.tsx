import type { ReactNode } from "react";
import type { SessionSummary } from "@/components/auth/session-badge";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * The persistent dashboard frame: a sidebar of sections, a topbar, and the
 * scrolling content region. Every page renders inside it, so contributors add
 * views without touching the chrome.
 */
export function DashboardShell({
  children,
  session,
}: {
  children: ReactNode;
  session: SessionSummary;
}) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-1 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar session={session} />
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-8 md:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
