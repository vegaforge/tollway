# Dashboard data contracts

A contributor guide for the Tollway observability dashboard (`apps/dashboard`). Every view here is meant to render against `@vegaforge/tollway-observability`. The hub itself shipped in #31, but nothing feeds it gate outcomes yet (tracked in #106), so for now each view either reads from a typed local seam under `apps/dashboard/src/data/` or shows a placeholder naming the source it will eventually consume. This document records both the primitives every view composes from and the contracts each view holds with its data source so new views stay consistent.

See also `docs/design.md`, "Observability", which lists what the dashboard is supposed to show and the webhook event set it consumes.

## The three UI primitives

Every dashboard widget is composed from three primitives in `apps/dashboard/src/components/ui/`. The rule is that a view never renders bare content: a widget is always a `Panel`, the data-free state of a widget is always an `EmptyState`, and a headline number is always a `StatCard`. Following that rule keeps the surface uniform without a heavier component system.

### `Panel`

The standard titled container. Every widget on every view sits in a `Panel`. It owns the border, the title, the optional description line, and the optional header action slot, so views never style those by hand.

```tsx
<Panel title="Open channels" description="Sorted by drawdown">
  {/* widget body */}
</Panel>
```

Props that matter: `title` (required), `description` (subtitle below the title), `action` (a node rendered on the right of the header, typically a small filter or "view all" link), and `children` (the body). The `className` prop lets a view space panels in a grid; the visual shell stays the same.

### `StatCard`

A single headline metric. Use it for top-of-view roll-ups like "Open channels", "Total spend", "Failure rate". The `value` is a `ReactNode` so you can render a number, a placeholder dash, or a skeleton without changing the card.

```tsx
<StatCard label="Total spend" value={formatAmount(totals.spend, "USDC")} hint="across all agents" />
```

A view that has a clear set of headline numbers should put them in a `grid` of `StatCard`s above its panels (see the Agents and Channels views for the worked layout).

### `EmptyState`

The placeholder a widget shows when its data is unavailable. Every unwired widget is required to use it, and the `source` prop must name the data source the widget will read from once it is wired. That is what turns the dashboard into a contributor map: a new contributor opens the running app, finds an empty state, reads its `source`, and knows exactly where to start.

```tsx
<EmptyState
  title="No receipts yet"
  body="Settled payments will appear here as canonical receipts, newest first."
  source="@vegaforge/tollway-core · SignedReceipt"
/>
```

`source` is rendered in a small monospace badge below the body so the link to the data layer is visually distinct from prose. Do not introduce a second placeholder pattern; use this one.

## The data-layer seam

Wired views (currently Agents, Channels and Exports) follow one pattern, and unwired views (Overview model mix, Services, Receipts, Anomalies) follow another.

### Wired views: the `useXxx` / `fetchXxx` seam

A wired view depends on exactly one hook in `apps/dashboard/src/data/`, and that hook depends on exactly one `fetchXxx` function in the same directory. The hook returns a discriminated union over the three render states the view cares about:

```ts
export type UseOpenChannelsState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; rows: OpenChannelRow[] };
```

The discriminated union is load-bearing: the view branches on `status` once and the type system prevents it from rendering rows while still loading or rendering an empty state while an error is in flight.

The row shape is owned by the data module, not the view. Two conventions hold across every row type:

1. Amounts are integer strings in the asset's smallest unit (Stellar SACs use 7 decimals), matching the canonical receipt and channel shapes in `@vegaforge/tollway-core` and `@vegaforge/tollway-channels`. The data layer never formats; the view does.
2. The asset code (`"USDC"`, etc.) travels alongside the amount on the row. Per-asset metadata, decimals included, will eventually attach here once the observability hub returns it.

The snapshot return type wraps the rows in an object (`OpenChannelsSnapshot`, `AgentSpendSnapshot`) so the seam stays stable when the hub starts attaching cursors, generated-at timestamps, or paging metadata.

When #31 lands, swapping the body of `fetchOpenChannels` or `fetchAgentSpend` for a real `summarize` call (or a direct `ChannelManager.list` iteration for channels) is the only change. The hook contract, the row shape, and every view downstream stay the same.

### Unwired views: an `EmptyState` with a `source`

A view that does not yet have a data hook renders an `EmptyState` directly inside its `Panel`. The `source` prop carries the contract: it names the `@vegaforge/tollway-observability` (or `@vegaforge/tollway-core`) symbol the view will eventually call. When you wire the view, that `source` is the import you reach for.

## View-to-source map

| Route | View | Current source | Future source |
| ----- | ---- | -------------- | ------------- |
| `/` | Overview | `StatCard` placeholders plus `EmptyState`s for model mix, spend over time, recent receipts, anomalies | `@vegaforge/tollway-observability` (`summarize`, and `timeseries` for spend over time, wiring tracked in #232), `@vegaforge/tollway-core` (`SignedReceipt`), `anomaly.detected` events |
| `/agents` | Per-agent spend | `useAgentSpend` -> `fetchAgentSpend` stub in `src/data/agent-spend.ts` | `summarize({ payer })` per agent, or a future `byPayer` rollup on the hub |
| `/agents/[agentId]` | One agent's spend, budget, and policy stops | `useAgentDetail` -> `fetchAgentDetail` stub in `src/data/agent-detail.ts` | #226 series filtered by payer, plus the #228 policy store per agent id |
| `/services` | Per-service revenue | `EmptyState` with `summarize({ payee })` as the named source | `summarize({ payee })`, plus `timeseries({ payee, ... })` for the latency-per-model breakdown |
| `/channels` | Open MPP channels | `useOpenChannels` -> `fetchOpenChannels` stub in `src/data/open-channels.ts` | Observability hub rollup over `channel.opened` / `channel.closed`, or a direct `ChannelManager.list` iteration |
| `/receipts` | Signed receipt archive | `EmptyState` with `@vegaforge/tollway-core · SignedReceipt` as the named source | Receipt archive backed by the observability hub's receipt stream |
| `/anomalies` | Anomaly feed | `EmptyState` with `anomaly.detected` as the named source | `anomaly.detected` event stream, with the rule that fired |
| `/exports` | Exports and webhooks | `useMetricsExport` -> `fetchMetricsExport` stub in `src/data/metrics-export.ts` for Exports; `EmptyState` for Webhooks | `@vegaforge/tollway-observability` `export()` for JSON and CSV, and the `WebhookEvent` set for outgoing webhooks |

The nav order in `apps/dashboard/src/components/shell/nav.ts` matches this table. Add new entries there when you add a route.

## Agent detail contract

`/agents/[agentId]` reads `AgentDetail` from `src/data/agent-detail.ts` through `useAgentDetail(agentId, { bucket, range })`, which loads again whenever the bucket (`hour`, `day`) or range (`24h`, `7d`, `30d`) changes. `AgentDetail` carries:

| Field | Meaning |
| ----- | ------- |
| `id`, `label`, `payerAddresses` | The agent's identity and the payer addresses it pays from |
| `query`, `from`, `to` | The bucket and range asked for, and the `[from, to)` window in UTC |
| `series` | One `AssetSeries` per asset: every bucket in the window, in time order, empty buckets as `"0"` |
| `byModel`, `byPayee` | Settled spend in the window, per `(model, asset)` and per `(payee, asset)` |
| `policy` | `AgentPolicyUsage`, or `null` when no policy governs the agent |
| `recentStops` | `PolicyStop`s, newest first |

### Agent to payer mapping

`Policy` in `packages/core/src/policy.ts` has no agent identity and `PaymentIntent` has no payer. `PaymentMetric.payer` in `@vegaforge/tollway-observability` is a payer address, not an agent id. The contract therefore carries an explicit `payerAddresses` list per agent, and every spend query runs once per address with the hub's `payer` filter and merges the rows. The page never derives a payer from an agent id by convention. Today the stub owns the map; the service will own it once #228 stores policies per agent id.

### Spend over time, model mix and services paid

All three come from the observability hub's `timeseries` query (`packages/observability/src/timeseries.ts`), with bucket `1h` or `1d` and `groupBy` `model` or `payee`. The window ends at the end of the bucket that holds "now" and spans the range, so buckets fall on UTC hour and day boundaries. `timeseries` sums settled payments only, so a failed or skipped payment never adds to a total, and its rows are keyed by asset, so amounts in different assets are never added together. When #226 serves the same query over HTTP, `fetchAgentDetail` swaps the in-process hub for that call and keeps the shape.

### Budget usage

`AgentPolicyUsage` measures each limit over the window the policy engine itself uses (`packages/core/src/policy.ts`):

| Limit | Window |
| ----- | ------ |
| `budgets.daily` | The current UTC day, the day `utcDate` names; the view labels it `UTC day YYYY-MM-DD` |
| `budgets.total` | Since the policy took effect (`effectiveFrom`) |
| `perService[payee].cap` | Since the policy took effect, for that payee |

The engine compares each asset's spend against the same single number, and the view does the same: one row per asset, each in that asset's own units, with a note that the unit is ambiguous until #191 keys budgets by asset. A limit the policy does not set reads "Not set in this policy". An agent without a policy shows a sentence saying nothing limits its spend, not an empty bar.

`percentageBasisPoints(used, limit)` multiplies by 10,000 before dividing, so the percentage is a `bigint` in basis points until the view formats it. A zero limit returns `null`, shown as "limit is 0", rather than an invented percentage. Usage over 100% is flagged "Over limit". Amounts are shown exactly in display units (7 decimals, the Stellar default) next to the base-unit limit, never rounded.

### Policy stops

A `PolicyStop` is a stored `PolicyTrace` from `@vegaforge/tollway-core`. `stopFromTrace` parses it with `policyTraceSchema`, which rejects an unknown trace version or a summary that contradicts its entries, and refuses a trace that did not block. The stop shows the blocking entry's rule id and its `detail`. The stub produces its traces by running the real engine's `evaluate()` over the agent's history, so the wording is exactly what the engine writes. The panel links to `/anomalies?agent=<id>`, which shows the filter until the anomaly feed is wired.

## Adding a new view

1. Add an entry to `navItems` in `src/components/shell/nav.ts`.
2. Create the route under `src/app/(dashboard)/<href>/page.tsx`, inside the route group whose layout checks the session. Use `PageHeader` for the title and lead.
3. If the view will be wired immediately, add a typed data module under `src/data/`. Export the row shape, a snapshot type, and a `fetchXxx` function; add a `useXxx` hook returning a `loading | error | ready` discriminated union over the snapshot. Mirror the conventions in `agent-spend.ts` and `open-channels.ts`.
4. If the view is a placeholder for now, use a `Panel` containing an `EmptyState` and name the future source via the `source` prop. That keeps the contributor map intact.
5. Cover the wired case with a Vitest component test that drives each state of the discriminated union (see `channels-view.test.tsx` and `agents-view.test.tsx`).

## Dashboard security

### Setup

The dashboard has its own users, separate from the service's API-key tenancy (#231). Configure it with server-side environment variables; `apps/dashboard/.env.example` shows the shape.

| Variable | Required | Meaning |
| -------- | -------- | ------- |
| `DASHBOARD_SESSION_SECRET` | yes | Signs session tokens and CSRF tokens. At least 32 bytes; generate one with `openssl rand -base64 48`. Changing it signs everyone out. |
| `DASHBOARD_AUTH_PROVIDER` | no | The identity provider. `credentials` (the default) is the only one today. |
| `DASHBOARD_USERS` | for `credentials` | JSON array of `{ "username", "passwordHash", "role" }`. `passwordHash` is a bcrypt hash of cost 10 or more; `role` is `viewer` or `admin`. |
| `DASHBOARD_ORIGIN` | behind a proxy | The public origin, for example `https://dashboard.example.com`. State-changing requests must carry exactly this `Origin`. Without it, the origin's host must match the `Host` (or `X-Forwarded-Host`) header. |
| `DASHBOARD_CLIENT_IP_HEADER` | no | A header your reverse proxy sets to the client address, such as `X-Real-IP`, to also rate-limit per client. Never name a header the proxy appends to. |

Create a hash from `apps/dashboard` without the password reaching your shell history or the process list:

```bash
read -rs PW && printf %s "$PW" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>console.log(require("bcryptjs").hashSync(s,12)))'; unset PW
```

The dashboard refuses to start a sign-in with a missing or short secret, a malformed user list, a plain-text or low-cost hash, or a duplicate username. Missing configuration is an error, not an open dashboard.

### Roles

| Role | Can |
| ---- | --- |
| `viewer` | Read every page and every read-only route |
| `admin` | Everything a viewer can, plus actions: today, revoking a session (`DELETE /api/admin/sessions/<sid>`); channel close (#227) and policy edits (#241) when they land |

Roles are checked on the server in every route handler through `authorizeRequest(request, role, { mutation })` in `src/lib/authorize.ts`, in server components through `currentSession()`, and in server actions through `requireSession(role)`, which throws before the action calls anything. `proxy.ts` makes the same session check first, but it is an early refusal, not the authority: a request that slips past the matcher is still refused by the handler. Hiding a button is never the control. When #237 adds service calls, an admin action checks the role before it calls the service, so a viewer cannot reach an admin call by crafting a request.

### Sessions

Signing in creates a session with a random id, stored in the server's session store, and sets the `tollway_dashboard_session` cookie: an HS256 token, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, with an expiry. A session lasts 8 hours from sign-in and is not extended by activity. Every check verifies the token and then asks the store whether that session is still live, so logging out or an admin revocation ends it at once, not at expiry. Logging out also clears the cookie.

The store, like the login rate limiter, is in the dashboard's memory. A restart signs everyone out and resets the limiter. Run one dashboard process; several replicas need a shared store first.

### Requests that change state

Every state-changing route handler requires the request's `Origin` to be the dashboard's own and an `x-csrf-token` header equal to the token bound to the session. The browser gets the token from the dashboard layout (or `GET /api/session`) and a cross-site page can neither read it nor set the header. Server actions get Next.js's own origin check on top of `requireSession`. Sign-in itself requires a same-origin `Origin`, so another site cannot sign a visitor in as someone else.

### Sign-in throttling and errors

Failed sign-ins are counted per username from every source (5 a minute), per client address when `DASHBOARD_CLIENT_IP_HEADER` is set (20 a minute), and in total (100 a minute); past a limit the route answers 429 with `Retry-After`. Successful sign-ins are not counted. An unknown username and a wrong password get the same 401 and the same message, and both run a bcrypt comparison of the same cost, so neither the answer nor its timing reveals which usernames exist. After sign-in the browser returns only to a path on the dashboard's own origin.

### What the browser never sees

The browser receives the session cookie (which scripts cannot read), the username, the role and the CSRF token. It never receives the session secret, password hashes, or the service API key: those stay in server-only modules, and no client component may import them.

## End-to-end tests

The Playwright suite in `apps/dashboard/e2e/` drives the production build in Chromium. Run it with:

```bash
pnpm --filter "@vegaforge/tollway-dashboard^..." build   # the workspace packages it imports
pnpm --filter @vegaforge/tollway-dashboard exec playwright install chromium   # once
pnpm --filter @vegaforge/tollway-dashboard test:e2e
```

`test:e2e` runs `next build`, then Playwright starts `next start` on `127.0.0.1:3124` with test-only users (`e2e`, a viewer, and `e2e-admin`; see `playwright.config.ts`) and runs every spec in three projects: `light` and `dark` desktop Chrome, and `mobile` (Pixel 7). It is not part of `pnpm test` or `./scripts/preflight.sh`, which stay browser-free. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` points it at a system Chromium instead of the downloaded one.

| Spec | Covers |
| ---- | ------ |
| `routes.spec.ts` | Every `navItems` route loads, shows its `PageHeader` with the right title, and is reachable from the sidebar (or the mobile menu); the agent detail page from the agents table |
| `flows.spec.ts` | Sorting the agents table, a receipt showing "Signature valid", a channel-commitment receipt linking to its channel, the theme surviving a reload, the agent detail controls, the anomalies link |
| `auth.spec.ts` | Redirect to login and back, 401 from the API, cookie flags, logout invalidating a replayed cookie, the uniform failure message, cross-origin and CSRF refusals, a viewer refused an admin route |
| `keyboard.spec.ts` | The skip link, Tab reaching every section with visible focus, receipt rows and the sort control from the keyboard |
| `mobile.spec.ts` | The topbar brand and the navigation menu on a small screen |
| `accessibility.spec.ts` | axe (WCAG 2.0 and 2.1 A and AA) on the login page and every route in each project, failing on serious or critical violations, with no rule disabled |

Every test also fails on a console error or uncaught exception (the `consoleErrors` fixture in `e2e/fixtures.ts`), which is how a hydration mismatch shows up.

To extend it: a new `navItems` entry is picked up by the route, keyboard and accessibility specs automatically, as long as the page renders a `PageHeader` (it carries `data-testid="page-header"`). Use roles and labels to find elements, and the existing `data-testid` hooks where a role is ambiguous. A finding from axe is a bug to fix in the component, never a rule to disable.

In CI the `dashboard e2e` job in `.github/workflows/ci.yml` runs the suite whenever a change touches `apps/dashboard`, the workspace packages it builds from, the lockfile or the workflow, caches the Playwright browsers, and uploads the report and traces when it fails. It is part of `quality`.
