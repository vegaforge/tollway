import bcrypt from "bcryptjs";
import { type Role, roles } from "./session";

/**
 * Who may sign in to the dashboard. The provider is chosen with
 * `DASHBOARD_AUTH_PROVIDER`; `credentials` (the default) reads users with
 * bcrypt password hashes from `DASHBOARD_USERS`, which works for a single
 * self-hosted team with no third-party account. Another provider (OIDC
 * against the operator's identity provider, for example) implements the
 * same interface. See docs/dashboard-data-contracts.md, "Dashboard security".
 */

export type AuthenticatedUser = { username: string; role: Role };

export interface IdentityProvider {
  /**
   * The user for these credentials, or null. Must take about as long for an
   * unknown username as for a wrong password, so the response time does not
   * reveal which usernames exist.
   */
  authenticate(username: string, password: string): Promise<AuthenticatedUser | null>;
}

export const authProviders = ["credentials"] as const;

type ConfiguredUser = AuthenticatedUser & { passwordHash: string };

// bcrypt's modular crypt format: version, two-digit cost, 22 salt and 31
// hash characters.
const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
// OWASP's floor for bcrypt. A cheaper hash is refused at startup rather
// than accepted with a warning nobody reads.
export const MIN_BCRYPT_COST = 10;

function invalidUsers(reason: string): Error {
  return new Error(`DASHBOARD_USERS is invalid: ${reason}`);
}

function parseUser(entry: unknown, index: number): ConfiguredUser {
  if (typeof entry !== "object" || entry === null) {
    throw invalidUsers(`entry ${index} is not an object`);
  }
  const { username, passwordHash, role } = entry as Record<string, unknown>;
  if (typeof username !== "string" || username.length === 0) {
    throw invalidUsers(`entry ${index} has no username`);
  }
  if (typeof passwordHash !== "string") {
    throw invalidUsers(`user ${username} has no passwordHash`);
  }
  const match = BCRYPT_HASH.exec(passwordHash);
  if (!match) {
    throw invalidUsers(`user ${username} passwordHash is not a bcrypt hash`);
  }
  if (Number(match[1]) < MIN_BCRYPT_COST) {
    throw invalidUsers(`user ${username} passwordHash cost is below ${MIN_BCRYPT_COST}`);
  }
  const knownRole = roles.find((candidate) => candidate === role);
  if (knownRole === undefined) {
    throw invalidUsers(`user ${username} role must be one of ${roles.join(", ")}`);
  }
  return { username, passwordHash, role: knownRole };
}

export function loadConfiguredUsers(raw = process.env.DASHBOARD_USERS): ConfiguredUser[] {
  if (!raw) {
    throw new Error("DASHBOARD_USERS is not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidUsers(`not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw invalidUsers("expected a non-empty JSON array");
  }
  const users = parsed.map(parseUser);
  const names = new Set<string>();
  for (const user of users) {
    if (names.has(user.username)) throw invalidUsers(`duplicate username ${user.username}`);
    names.add(user.username);
  }
  return users;
}

/**
 * Compared against when the username is unknown, so that path pays the same
 * bcrypt cost as a wrong password. Generated per cost and never matches a
 * real password because nobody knows its input.
 */
const dummyHashes = new Map<number, string>();

function dummyHash(cost: number): string {
  let hash = dummyHashes.get(cost);
  if (hash === undefined) {
    hash = bcrypt.hashSync(crypto.randomUUID(), cost);
    dummyHashes.set(cost, hash);
  }
  return hash;
}

function costOf(passwordHash: string): number {
  return Number(passwordHash.slice(4, 6));
}

export function credentialsProvider(users: ConfiguredUser[]): IdentityProvider {
  const highestCost = Math.max(...users.map((user) => costOf(user.passwordHash)));
  return {
    async authenticate(username, password) {
      const user = users.find((candidate) => candidate.username === username);
      const matches = await bcrypt.compare(password, user?.passwordHash ?? dummyHash(highestCost));
      return user !== undefined && matches ? { username: user.username, role: user.role } : null;
    },
  };
}

export function loadIdentityProvider(): IdentityProvider {
  // An empty value counts as unset, the way an empty line in a .env file reads.
  const name = process.env.DASHBOARD_AUTH_PROVIDER || "credentials";
  switch (name) {
    case "credentials":
      return credentialsProvider(loadConfiguredUsers());
    default:
      throw new Error(
        `DASHBOARD_AUTH_PROVIDER ${name} is not supported; use one of ${authProviders.join(", ")}`,
      );
  }
}
