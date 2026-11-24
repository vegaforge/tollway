import type { ChannelManager } from "@vegaforge/tollway-channels";
import type { ObservabilityHub } from "@vegaforge/tollway-observability";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authenticate } from "./auth.js";
import { apiKeyScopes, type ServiceConfig } from "./config.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { createConsoleLogger, describeError, type ServiceLogger } from "./logger.js";
import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.js";
import { checkReadiness, readinessReportSchema } from "./readiness.js";
import { defineRoute, mountRoutes, type ServiceRoute } from "./routes.js";
import { createMemoryStores, type ServiceStores } from "./stores.js";
import type { ServiceEnv } from "./types.js";

/** The service API version reported in `/openapi.json`. */
export const SERVICE_API_VERSION = "0.1.0";

/** What a route module receives: the parsed config, the stores and the logger. */
export type ServiceContext = {
  config: ServiceConfig;
  stores: ServiceStores;
  logger: ServiceLogger;
  /**
   * The deployment's own channel manager, for the channels API (#227). The
   * service only exposes channels this manager tracks.
   */
  channelManager?: ChannelManager;
  /** Where modules emit events, for example `channel.closed`. */
  observability?: Pick<ObservabilityHub, "emit">;
};

/**
 * A group of routes, for example the receipts API from #225. It is a function
 * of the context so its handlers can reach the stores without globals.
 */
export type ServiceModule = (context: ServiceContext) => readonly ServiceRoute[];

export type CreateServiceOptions = {
  /** Parsed configuration; see `parseServiceConfig`. */
  config: ServiceConfig;
  /**
   * Backing stores. Any store left out uses its in-memory implementation,
   * which keeps state only for the life of the process.
   */
  stores?: Partial<ServiceStores>;
  /** Route modules mounted after the built-in routes. */
  modules?: readonly ServiceModule[];
  /** Defaults to JSON lines through `console`. */
  logger?: ServiceLogger;
  /**
   * The channel manager the channels module reads and closes through. Its
   * store is pluggable, so a persistent backend (#177, #178) needs no change
   * here.
   */
  channelManager?: ChannelManager;
  /** The observability hub modules emit events through. */
  observability?: Pick<ObservabilityHub, "emit">;
};

/**
 * Builds the service as a Hono app. Nothing listens: the `tollway-service`
 * binary passes `app.fetch` to `@hono/node-server`, and any other runtime that
 * speaks the Fetch API can serve it the same way.
 *
 * The service holds no signing or funding key and makes no outbound call of
 * its own. The only network traffic it can cause is to the stores and webhook
 * targets the operator configures.
 */
export function createService(options: CreateServiceOptions): Hono<ServiceEnv> {
  const { config } = options;
  const logger = options.logger ?? createConsoleLogger();
  const stores: ServiceStores = { ...createMemoryStores(), ...options.stores };
  const context: ServiceContext = {
    config,
    stores,
    logger,
    ...(options.channelManager === undefined ? {} : { channelManager: options.channelManager }),
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  };

  const app = new Hono<ServiceEnv>();

  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    // Only these fields are logged. Headers, including Authorization, and
    // the query string never reach a log line.
    logger.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      key: c.get("apiKey")?.name ?? null,
    });
  });

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) =>
        c.json(
          errorBody(
            "payload-too-large",
            `the request body is larger than ${config.maxBodyBytes} bytes`,
          ),
          413,
        ),
    }),
  );
  app.use("/v1/*", authenticate(config.apiKeys));

  app.notFound((c) =>
    c.json(errorBody("not-found", `no route for ${c.req.method} ${c.req.path}`), 404),
  );
  app.onError((error, c) => {
    logger.error("unhandled-error", {
      method: c.req.method,
      path: c.req.path,
      ...describeError(error),
    });
    return c.json(errorBody("internal-error", "the service could not complete the request"), 500);
  });

  const routes: ServiceRoute[] = [];
  let document: OpenApiDocument | undefined;

  routes.push(
    defineRoute({
      method: "get",
      path: "/healthz",
      summary: "Liveness",
      description: "Answers while the process is serving. It calls no store.",
      tags: ["system"],
      responses: {
        200: {
          description: "The process is alive.",
          schema: z.object({ status: z.literal("ok") }),
        },
      },
      handler: (c) => c.json({ status: "ok" as const }),
    }),
    defineRoute({
      method: "get",
      path: "/readyz",
      summary: "Readiness",
      description: "Checks every backing store and reports each one as ok or failing.",
      tags: ["system"],
      responses: {
        200: { description: "Every store is ready.", schema: readinessReportSchema },
        503: {
          description: "At least one store failed its check.",
          schema: errorBodySchema,
        },
      },
      handler: async (c) => {
        const report = await checkReadiness(stores, config.readinessTimeoutMs, logger);
        if (report.status === "ready") return c.json(report);
        return c.json(errorBody("not-ready", "a backing store is not ready", report), 503);
      },
    }),
    defineRoute({
      method: "get",
      path: "/openapi.json",
      summary: "OpenAPI document",
      description: "This document, generated from the schemas the routes validate with.",
      tags: ["system"],
      responses: {
        200: { description: "An OpenAPI 3.1 document.", schema: z.record(z.string(), z.unknown()) },
      },
      handler: (c) => {
        document ??= buildOpenApiDocument(routes, SERVICE_API_VERSION);
        return c.json(document);
      },
    }),
    defineRoute({
      method: "get",
      path: "/v1/whoami",
      summary: "The calling API key",
      description: "Returns the name and scopes of the key that made the request, never the key.",
      tags: ["system"],
      scope: null,
      responses: {
        200: {
          description: "The key's name and scopes.",
          schema: z.object({ name: z.string(), scopes: z.array(z.enum(apiKeyScopes)) }),
        },
      },
      handler: (c) => {
        const key = c.get("apiKey");
        return c.json({ name: key.name, scopes: [...key.scopes] });
      },
    }),
  );

  for (const module of options.modules ?? []) routes.push(...module(context));
  mountRoutes(app, routes);
  return app;
}
