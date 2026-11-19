"use client";

import { type FormEvent, useState } from "react";
import { safeNextPath } from "@/lib/safe-redirect";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    let response: Response;
    try {
      response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      // fetch rejects only when the request never completed.
      setError("Could not reach the dashboard. Check your connection and try again.");
      setSubmitting(false);
      return;
    }

    if (!response.ok) {
      // The same words for an unknown user and a wrong password.
      setError(
        response.status === 429
          ? "Too many failed attempts. Wait a minute and try again."
          : "Sign-in failed. Check your credentials and try again.",
      );
      setSubmitting(false);
      return;
    }

    window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next")));
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <form onSubmit={onSubmit} className="w-full rounded-xl border border-border bg-surface p-6">
          <h1 className="text-xl font-semibold">Tollway dashboard</h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue.</p>

          <label className="mt-6 block text-sm font-medium" htmlFor="username">
            Username
          </label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2"
            required
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2"
            required
          />

          {error ? (
            <p role="alert" className="mt-4 text-sm text-foreground">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
          >
            {submitting ? "Signing in" : "Sign in"}
          </button>
        </form>
      </main>
    </div>
  );
}
