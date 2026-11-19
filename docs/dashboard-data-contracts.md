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

Wired views (currently Agents and Channels) follow one pattern, and unwired views (Overview model mix, Services, Receipts, Anomalies, Exports) follow another.

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
| `/exports` | Exports and webhooks | Two `EmptyState`s, one per panel | `@vegaforge/tollway-observability` `export()` for JSON and CSV, and the `WebhookEvent` set for outgoing webhooks |

The nav order in `apps/dashboard/src/components/shell/nav.ts` matches this table. Add new entries there when you add a route.

## Agent detail contract

`/agents/[agentId]` consumes `AgentDetail` from `src/data/agent-detail.ts` through the `useAgentDetail(agentId)` hook. It carries identity (`id`, `label`, `payerAddresses`), settled spend as a time series per asset and bucket (`series`), spend by model and by payee (`byModel`, `byPayee`), the current policy with its usage (`policy`, or `null` when the agent has none), and `recentStops`.

### Agent to payer mapping

`Policy` in `packages/core/src/policy.ts` has no agent identity and `PaymentIntent` has no payer. `PaymentMetric.payer` in `@vegaforge/tollway-observability` is a payer address, not an agent id. The detail contract therefore carries an explicit `payerAddresses: string[]` per agent. The deterministic stub owns that map; the page never derives a payer from an agent id by string convention. A real implementation of `fetchAgentDetail` must keep the mapping explicit so spend cannot be attributed to the wrong agent.

### Amounts, buckets, and budget usage

Every amount is an integer base-unit string. `bucketSeries` and `seriesByAsset` count only metrics with `outcome === "settled"`, group by UTC hour or UTC day, and never sum across assets. `byModel` and `byPayee` are keyed by `(key, asset)` for the same reason.

`percentageBasisPoints(used, budget)` multiplies by 10,000 before dividing, so a percentage is a `bigint` in basis points at every step and becomes a display string only in the view. The daily budget is labelled as a UTC day, matching `utcDate` in `packages/core/src/policy.ts`. Each asset's usage is compared against the policy's single-number budget separately; a zero budget with spend is shown as fully consumed. The view states the unit ambiguity until #191 keys budgets by asset. An agent without a policy renders an explicit message instead of an empty budget bar.

Recent stops carry a rule name, a detail string, and a timestamp. Each links to `/anomalies?agent=<id>`.

## Adding a new view

1. Add an entry to `navItems` in `src/components/shell/nav.ts`.
2. Create the route under `src/app/<href>/page.tsx`. Use `PageHeader` for the title and lead.
3. If the view will be wired immediately, add a typed data module under `src/data/`. Export the row shape, a snapshot type, and a `fetchXxx` function; add a `useXxx` hook returning a `loading | error | ready` discriminated union over the snapshot. Mirror the conventions in `agent-spend.ts` and `open-channels.ts`.
4. If the view is a placeholder for now, use a `Panel` containing an `EmptyState` and name the future source via the `source` prop. That keeps the contributor map intact.
5. Cover the wired case with a Vitest component test that drives each state of the discriminated union (see `channels-view.test.tsx` and `agents-view.test.tsx`).

## Authentication contract

The dashboard session is independent of the service API key. `DASHBOARD_USERS` is a server-side JSON array of `{ username, passwordHash, role }`, where `role` is `viewer` or `admin`, and `DASHBOARD_SESSION_SECRET` signs the session token. `apps/dashboard/.env.example` shows the shape with a throwaway hash. Never commit real credentials.

`src/lib/session.ts` signs and verifies the compact HS256 token; `src/lib/session-store.ts` tracks active and revoked session ids in memory; `src/lib/users.ts` verifies bcrypt password hashes; `src/lib/csrf.ts` checks request origin and a session-bound token; `src/lib/rate-limit.ts` counts failed logins per username and client address. All of these are server-only. `proxy.ts` redirects unauthenticated page requests to `/login?next=<path>` and returns JSON 401 for `/api/**`, while `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/session`, and `DELETE /api/admin/sessions/[sid]` re-check the session and role before doing work. Revocation and rate limits reset on restart, so a multi-instance deployment needs a shared store before production use.

When #237 lands, the service API key stays server side. A browser component may use the session identity from `GET /api/session`, but it must never import or read the service key.

## Browser tests

Run `pnpm --filter @vegaforge/tollway-dashboard test:e2e`. The script builds the production dashboard, then Playwright starts `next start` on `127.0.0.1:3124` and runs the suites in light, dark, and mobile Chromium projects. A local Chromium override is available through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; CI installs the matching browser with `playwright install --with-deps chromium`.

The route suite generates cases from `navItems`, so a new navigation entry must render a `PageHeader` with its `data-testid="page-header"` hook. Flow tests cover UI sign-in, protected navigation, sign-out, and keyboard theme toggling. The keyboard test uses the focusable receipt-select button, and the accessibility suite runs axe with serious and critical violations failing the build. The shell's skip link targets `<main id="main-content">`. Keep these hooks and controls when changing the shell.

CI runs the browser suite in the `e2e` job of `.github/workflows/ci.yml`, adds it to `quality.needs`, and reports success without a browser run when the pull request touches none of `apps/dashboard/**`, `pnpm-lock.yaml`, or that workflow. Failures upload the Playwright report and test results.
