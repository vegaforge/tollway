/**
 * Service entry point. Starts the HTTP server on the port configured by
 * the `PORT` environment variable (default 3200).
 */

import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3200);
serve({ fetch: app.fetch, port });
console.log(`tollway-service listening on :${port}`);
