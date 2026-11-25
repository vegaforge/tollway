---
"@vegaforge/tollway-service": minor
---

Adds the channels API (#227) as `createChannelsModule()`: `GET /v1/channels`, `GET /v1/channels/{id}`, `GET /v1/channels/{id}/commitments` and `POST /v1/channels/{id}/close`. `createService` takes a `channelManager` and an optional `observability` hub, and route modules receive both through `ServiceContext`. A close is idempotent and shared across concurrent requests in one process, records the requesting key's name, and emits `channel.closed`. Two error codes are added: `conflict` and `close-failed`.
