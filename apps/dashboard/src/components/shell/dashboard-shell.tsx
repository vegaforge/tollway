import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * The persistent dashboard frame: a sidebar of sections, a topbar, and the
 * scrolling content region. Every page renders inside it, so contributors add
 * views without touching the chrome.
 */
export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}
