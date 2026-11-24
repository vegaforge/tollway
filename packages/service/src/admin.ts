import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { defineRoute } from "./routes.js";

/**
 * Explicit cross-tenant operator route (#231): returns per-tenant record counts
 * from `AdminStore`, gated by dedicated `operatorKeys`. Tenant API keys,
 * including keys with the `admin` scope, are refused with 403.
 */

/** Schema for one per-tenant count summary row returned by `GET /v1/admin/tenants`. */
export const tenantSummarySchema = z.object({
  orgId: z.string(),
  projectId: z.string(),
  receipts: z.number().int().nonnegative(),
  metrics: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  commitments: z.number().int().nonnegative(),
  policyVersions: z.number().int().nonnegative(),
  auditEntries: z.number().int().nonnegative(),
  totalRecords: z.number().int().nonnegative(),
});

/** Builds the operator-only cross-tenant summary module (`GET /v1/admin/tenants`). */
export function adminModule(): ServiceModule {
  return ({ adminStore }) => [
    defineRoute({
      method: "get",
      path: "/v1/admin/tenants",
      summary: "List per-tenant record counts",
      description:
        "Operator-only overview of active tenants and their stored record counts. Never returns raw receipts, metrics, channels or policies.",
      tags: ["admin"],
      scope: "operator",
      responses: {
        200: {
          description: "Per-tenant record counts.",
          schema: z.object({ tenants: z.array(tenantSummarySchema) }),
        },
      },
      handler: async (c) => c.json({ tenants: await adminStore.listTenants() }),
    }),
  ];
}
