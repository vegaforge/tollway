---
date: 2026-11-24
feature: Channel lifecycle events, demotion from channels when traffic drops, MPP channel settler, and channel fallback
scope: feat
packages: ["@vegaforge/tollway-channels", "@vegaforge/tollway-client", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Channel Lifecycle Management

Four enhancements for production channel operations:

**Channel lifecycle events** (#187): The channel manager and client now emit `channel:opened` and `channel:closed` events to the client event stream and observability. These events are automatically wired to `ObservabilityHub` for dashboarding and webhooks, so operators see channels open and close in real time.

**Traffic-based demotion** (#182): The router now demotes from `mpp-channel` back to `x402` when observed traffic on a counterparty drops below a configurable threshold (default 10 requests/minute). Avoids paying per-channel open and close overhead on low-frequency traffic. The demotion reason is `"traffic"` in route decision logs.

**MPP channel ClientSettler** (#184): The `createMppChannelSettler` opens channels on demand, makes commitments, and closes channels when needed. Accepts injected channel manager, funder address, and optional fallback settler. Integrates with the client's standard settlement pipeline.

**Channel open failure fallback** (#183): When a channel open fails, the settler automatically falls back to the provided `fallbackSettler` (typically x402) so payments continue. No impact on the caller: the settled receipt is returned normally, and the channel open error is emitted as an `error` event for observability.

All are opt-in and do not affect existing code that uses the client without the channel settler.
