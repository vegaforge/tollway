import type { Session } from "./session";

type StoredSession = {
  session: Session;
  revoked: boolean;
};

const sessions = new Map<string, StoredSession>();

export function rememberSession(session: Session): void {
  sessions.set(session.sid, { session, revoked: false });
}

export function isActiveSession(session: Session): boolean {
  const stored = sessions.get(session.sid);
  if (!stored || stored.revoked || stored.session.exp * 1000 <= Date.now()) {
    return false;
  }
  return session.exp === stored.session.exp && session.role === stored.session.role;
}

export function revokeSession(sid: string): void {
  const stored = sessions.get(sid);
  if (stored) {
    stored.revoked = true;
  }
}

export function resetSessionStore(): void {
  sessions.clear();
}
