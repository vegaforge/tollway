"use client";

import { useEffect, useState } from "react";

type SessionInfo = {
  username: string;
  role: "viewer" | "admin";
  csrfToken: string;
};

export function SessionBadge() {
  const [session, setSession] = useState<SessionInfo | null>(null);

  useEffect(() => {
    async function load() {
      const response = await fetch("/api/session");
      if (!response.ok) {
        setSession(null);
        return;
      }
      setSession((await response.json()) as SessionInfo);
    }
    void load();
  }, []);

  async function signOut() {
    if (!session) {
      return;
    }
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
    });
    window.location.assign("/login");
  }

  if (!session) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-muted sm:inline">
        {session.username} · {session.role}
      </span>
      <button
        type="button"
        onClick={signOut}
        className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        Sign out
      </button>
    </div>
  );
}
