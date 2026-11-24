import type { AuthenticatedKey } from "./auth.js";

/**
 * The Hono environment every service route runs in. `apiKey` is set by the
 * authentication middleware on `/v1/*` before any route handler runs.
 */
export type ServiceEnv = {
  Variables: {
    apiKey: AuthenticatedKey;
  };
};
