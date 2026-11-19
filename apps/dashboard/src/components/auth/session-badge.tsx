"use client";

import { useState } from "react";

/** What the browser is told about its own session. Never the token itself. */
export type SessionSummary = {
  username: string;
  role: "viewer" | "admin";
  /** Sent back in `x-csrf-token` on state-changing requests. */
  csrfToken: string;
};

export function SessionBadge({ session }: { session: SessionSummary }) {
  const [error, setError] = useState("");

  async function signOut() {
    setError("");
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
    });
    // A 401 means the session had already ended, which is the goal anyway.
    if (response.ok || response.status === 401) {
      window.location.assign("/login");
      return;
    }
    setError("Sign-out failed. Try again.");
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-muted sm:inline" data-testid="session-identity">
        {session.username} · {session.role}
      </span>
      <button
        type="button"
        onClick={signOut}
        className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        Sign out
      </button>
      {error ? (
        <span role="alert" className="text-xs text-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}
