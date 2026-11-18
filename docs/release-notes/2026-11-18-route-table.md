---
date: 2026-11-18
feature: Configure paid endpoints in one route table
scope: feat
packages: [@vegaforge/tollway-server, @vegaforge/tollway-adapter-express, @vegaforge/tollway-adapter-fastify, @vegaforge/tollway-adapter-hono, @vegaforge/tollway-adapter-next]
scenario-impact: needs_automation
---

# Paid route tables

Services can compile method and path pricing into one route table and use it from each framework adapter. Matching normalizes paths, shares settlement idempotency state, and binds receipts to the selected route resource.
