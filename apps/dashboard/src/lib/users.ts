import bcrypt from "bcryptjs";
import type { Role } from "./session";

export type ConfiguredUser = {
  username: string;
  passwordHash: string;
  role: Role;
};

export function loadUsers(): ConfiguredUser[] {
  const raw = process.env.DASHBOARD_USERS;
  if (!raw) {
    throw new Error("DASHBOARD_USERS is not configured");
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("DASHBOARD_USERS must be a JSON array");
  }

  return parsed.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { username?: unknown }).username !== "string" ||
      typeof (entry as { passwordHash?: unknown }).passwordHash !== "string" ||
      ((entry as { role?: unknown }).role !== "viewer" &&
        (entry as { role?: unknown }).role !== "admin")
    ) {
      throw new Error("DASHBOARD_USERS contains an invalid user");
    }
    const user = entry as ConfiguredUser;
    return {
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role,
    };
  });
}

export function verifyCredentials(username: string, password: string): ConfiguredUser | null {
  const user = loadUsers().find((candidate) => candidate.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return null;
  }
  return user;
}
