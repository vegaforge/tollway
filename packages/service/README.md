# @vegaforge/tollway-service

The optional, self-hosted Tollway shared service: a [Hono](https://hono.dev) app with typed configuration, API-key authentication, health and readiness endpoints, and an OpenAPI document generated from the same zod schemas that validate each request.

Most users do not need it. Run it when budgets, receipts, metrics or channels have to be shared across many processes. Full documentation: [`apps/web/src/content/docs/service.mdx`](../../apps/web/src/content/docs/service.mdx).

## What it will never do

- **Hold a key that signs or pays.** Its configuration has no receipt signing key, no Stellar secret and no facilitator credential. It cannot move funds or issue a receipt.
- **Call out on its own.** It makes no outbound network call except to the stores and webhook targets the operator configures: no telemetry, no update check. `src/app.test.ts` runs every route with `fetch` stubbed to fail and asserts it is never called.
- **Reveal a credential.** API keys are configured as SHA-256 hashes, compared in constant time, and never written to a response or a log line.

## Run

```bash
KEY=$(openssl rand -base64 32)
HASH=$(printf '%s' "$KEY" | npx tollway-service hash-key)

TOLLWAY_SERVICE_PORT=8787 \
TOLLWAY_SERVICE_API_KEYS="[{\"name\":\"ops\",\"sha256\":\"$HASH\",\"scopes\":[\"read\"]}]" \
npx tollway-service

curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/whoami
```

| Variable | Required | Default |
| --- | --- | --- |
| `TOLLWAY_SERVICE_PORT` | yes | none |
| `TOLLWAY_SERVICE_API_KEYS` | yes | none |
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

Feature routes are modules: functions of the config, stores and logger that return route declarations. One declaration mounts the route, checks its scope, validates its input and documents it in `/openapi.json`.

```ts
import { createService, defineRoute, type ServiceModule } from "@vegaforge/tollway-service";
import { z } from "zod";

const receipts: ServiceModule = ({ stores }) => [
  defineRoute({
    method: "get",
    path: "/v1/receipts/{id}",
    summary: "One receipt",
    scope: "read",
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: { 200: { description: "The receipt." } },
    handler: async (c, { params }) => {
      const receipt = await stores.receipts.get(params.id);
      return receipt === undefined
        ? c.json({ error: { code: "not-found", message: "no such receipt" } }, 404)
        : c.json(receipt);
    },
  }),
];

createService({ config, modules: [receipts] });
```

Every `/v1` route must declare a scope (`null` accepts any valid key); a route outside `/v1` is public and cannot.

## Channels

`createChannelsModule()` serves the channels this deployment's `ChannelManager` tracks: list, detail, commitment stream and an admin close. Pass the manager, and optionally an observability hub for `channel.closed`:

```ts
createService({ config, channelManager, observability: hub, modules: [createChannelsModule()] });
```

See the service docs page for the routes and how a close behaves.
