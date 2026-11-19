# ADR for Dummies: Framework-agnostic paid route table

- **Status:** Accepted 2026-11-18
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-route-table](ADR-2026-11-18-route-table.md)

## The idea

Let a service list its paid paths, methods, and prices in one table. All four framework adapters use the same matching rules, and one payment for one route cannot pay for another route.

## What people see

1. The service creates one route table with entries such as `GET /quotes/:symbol` and `POST /infer`.
2. The framework installs one Tollway middleware for that table. A free path continues normally; a paid path gets its configured challenge or payment result.
3. Operators can list the table's routes and prices for discovery or a dashboard.

## Important limitation

The table only protects requests that pass through its adapter middleware. It does not change how facilitators settle payments or make Tollway custody funds.

## What changes

The server gains a route-table compiler and all four adapters gain a way to use it. The matching and price list become documented, tested public behavior.

## What does not change

Each existing single-gate API continues to work. Payment protocol logic stays in the server package.
