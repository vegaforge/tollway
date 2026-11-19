import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { currentSession } from "@/lib/authorize";
import { csrfToken } from "@/lib/csrf";

/**
 * Every dashboard page renders inside this layout, which checks the session
 * on the server as well as in proxy.ts. The login page sits outside the
 * group, so it has neither the shell nor the check.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  if (session === null) {
    redirect("/login");
  }
  return (
    <DashboardShell
      session={{
        username: session.username,
        role: session.role,
        csrfToken: csrfToken(session.sid),
      }}
    >
      {children}
    </DashboardShell>
  );
}
