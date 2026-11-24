# @vegaforge/tollway-service

The optional, self-hosted Tollway shared service: a multi-tenant [Hono](https://hono.dev) app with typed configuration, tenant-bound API-key authentication, per-tenant quotas, health and readiness endpoints, and an OpenAPI document generated from the same zod schemas that validate each request.

Most users do not need it. Run it when budgets, receipts, metrics or channels have to be shared across many processes or isolated across teams and projects. Full documentation: [`apps/web/src/content/docs/service.mdx`](../../apps/web/src/content/docs/service.mdx).

## What it will never do

- **Hold a key that signs or pays.** Its configuration has no receipt signing key, no Stellar secret and no facilitator credential. It cannot move funds or issue a receipt.
- **Call out on its own.** It makes no outbound network call except to the stores and webhook targets the operator configures: no telemetry, no update check. `src/app.test.ts` and `src/isolation.test.ts` run every route with `fetch` stubbed to fail and assert it is never called.
- **Reveal a credential or mix tenants.** API keys are configured as SHA-256 hashes bound to one `orgId` and `projectId`, compared in constant time, and never written to a response or a log line. Request tenancy comes only from the authenticated key.

## Run

```bash
KEY=$(openssl rand -base64 32)
HASH=$(printf '%s' "$KEY" | npx tollway-service hash-key)

TOLLWAY_SERVICE_PORT=8787 \
TOLLWAY_SERVICE_API_KEYS="[{\"name\":\"ops\",\"orgId\":\"acme\",\"projectId\":\"payments\",\"sha256\":\"$HASH\",\"scopes\":[\"read\"]}]" \
npx tollway-service

curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/whoami
```

| Variable | Required | Default |
| --- | --- | --- |
| `TOLLWAY_SERVICE_PORT` | yes | none |
| `TOLLWAY_SERVICE_API_KEYS` | yes | none |
| `TOLLWAY_SERVICE_OPERATOR_KEYS` | no | none: operator keys for `/v1/admin/tenants` |
| `TOLLWAY_SERVICE_CURSOR_SECRET` | no | per-process random secret (set 32+ chars across replicas) |
| `TOLLWAY_SERVICE_QUOTAS` | no | none: optional per-tenant ingest rate and record caps |
| `TOLLWAY_SERVICE_HOST` | no | `127.0.0.1` |
| `TOLLWAY_SERVICE_READINESS_TIMEOUT_MS` | no | `2000` |
| `TOLLWAY_SERVICE_MAX_BODY_BYTES` | no | `1048576` |
| `TOLLWAY_SERVICE_CONFIG_FILE` | no | none: a JSON file with the same fields |

## Embed

```ts
import { createService, parseServiceConfig } from "@vegaforge/tollway-service";

const app = createService({ config: parseServiceConfig({ env: process.env }) });
// app.fetch is a standard Fetch API handler.
```

## Add routes

Feature routes are modules: functions of the config, tenant-scoped stores and logger that return route declarations. One declaration mounts the route, checks its scope, validates its input and documents it in `/openapi.json`.

```ts
import {
  createService,
  defineRoute,
  type ServiceModule,
  tenantOf,
} from "@vegaforge/tollway-service";
import { z } from "zod";

const customReceipts: ServiceModule = ({ stores }) => [
  defineRoute({
    method: "get",
    path: "/v1/custom-receipts/{id}",
    summary: "One receipt in the caller's tenant",
    scope: "read",
    request: { params: z.strictObject({ id: z.string().min(1) }) },
    responses: { 200: { description: "The receipt." } },
    handler: async (c, { params }) => {
      const found = await stores.receipts.get(tenantOf(c), params.id);
      return found === undefined
        ? c.json({ error: { code: "not-found", message: "no such receipt" } }, 404)
        : c.json(found.receipt);
    },
  }),
];

createService({ config, modules: [customReceipts] });
```

Every `/v1` route must declare a scope (`null` accepts any valid tenant key, `"operator"` accepts only an operator key); a route outside `/v1` is public and cannot.

## Channels

`createChannelsModule()` serves the channels tracked per tenant: list, detail, commitment stream and an admin close. Build per-tenant managers over one `ChannelStore` with `createTenantChannelManagers`:

```ts
import {
  createChannelsModule,
  createMemoryStores,
  createService,
  createTenantChannelManagers,
} from "@vegaforge/tollway-service";

const stores = createMemoryStores();
const channelManagers = createTenantChannelManagers({ store: stores.channels, adapter });

createService({
  config,
  stores,
  channelManagers,
  observability: hub,
  modules: [createChannelsModule()],
});
```

See the service docs page for the tenancy model, PostgreSQL row-level security, per-tenant quotas and single-tenant deployment guidance.
