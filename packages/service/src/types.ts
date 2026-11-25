import type { AuthenticatedKey, AuthenticatedOperator } from "./auth.js";

/** Hono context variables set by the service's authentication middleware. */
export type ServiceEnv = {
  Variables: {
    apiKey?: AuthenticatedKey;
    operatorKey?: AuthenticatedOperator;
  };
};
