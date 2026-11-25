/**
 * @vegaforge/tollway-service Hono application.
 *
 * Mounts all routers. Exported as `app` so tests can use `app.request()`.
 */

import { Hono } from "hono";
import { eventsRouter } from "./routes/events.js";

export const app = new Hono();

app.route("/v1/events", eventsRouter);

app.get("/health", (c) => c.json({ ok: true }));
