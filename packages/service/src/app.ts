import type { ChannelManager } from "@vegaforge/tollway-channels";
import type { ObservabilityHub } from "@vegaforge/tollway-observability";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authenticate, requireTenantKey } from "./auth.js";
import { apiKeyScopes, type ServiceConfig } from "./config.js";
import { errorBody, errorBodySchema } from "./errors.js";
import { createConsoleLogger, describeError, type ServiceLogger } from "./logger.js";
import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.js";
import { createQuotaEnforcer, type QuotaEnforcer } from "./quotas.js";
import { checkReadiness, readinessReportSchema } from "./readiness.js";
import { defineRoute, mountRoutes, type ServiceRoute } from "./routes.js";
import {
  type AdminStore,
  createMemoryAdminStore,
  createMemoryStores,
  type ServiceStores,
} from "./stores.js";
import { type CursorCodec, createCursorCodec, type TenantScope } from "./tenancy.js";
import type { ServiceEnv } from "./types.js";

/** The service API version reported in `/openapi.json`. */
export const SERVICE_API_VERSION = "0.1.0";

/** Minimal `ObservabilityHub` surface modules emit lifecycle events through. */
export type ObservabilitySink = Pick<ObservabilityHub, "emit">;

/** Either a single deployment sink or a per-tenant sink resolver. */
export type ObservabilitySource =
  | ObservabilitySink
  | ((tenant: TenantScope) => ObservabilitySink | undefined);

/** What a route module receives: the parsed config, the stores and the logger. */
export type ServiceContext = {
  config: ServiceConfig;
  stores: ServiceStores;
  /** Separate cross-tenant summary store, reachable only by operator-scoped routes. */
  adminStore: AdminStore;
  logger: ServiceLogger;
  /** HMAC-SHA256 codec that binds pagination cursors to `(orgId, projectId, route, query)`. */
  cursors: CursorCodec;
  /** Per-tenant ingest rate and record-count quota enforcer. */
  quotas: QuotaEnforcer;
  /**
   * Per-tenant channel manager resolver (#227, #231). Each tenant gets an
   * isolated manager over its own channel partition.
   */
  channelManagers?: (tenant: TenantScope) => ChannelManager | undefined;
  /** Resolves the observability sink for `tenant`, preventing cross-tenant webhook fan-out. */
  observabilityFor: (tenant: TenantScope) => ObservabilitySink | undefined;
};

/**
 * A group of routes, for example the receipts API from #225. It is a function
 * of the context so its handlers can reach the stores without globals.
 */
export type ServiceModule = (context: ServiceContext) => readonly ServiceRoute[];

/** Options passed to {@link createService}. */
export type CreateServiceOptions = {
  /** Parsed configuration; see `parseServiceConfig`. */
  config: ServiceConfig;
  /**
   * Backing stores. Any store left out uses its in-memory implementation,
   * which keeps state only for the life of the process.
   */
  stores?: Partial<ServiceStores>;
  /** Cross-tenant summary store for `adminModule()`. Defaults to an in-memory aggregator. */
  adminStore?: AdminStore;
  /** Route modules mounted after the built-in routes. */
  modules?: readonly ServiceModule[];
  /** Defaults to JSON lines through `console`. */
  logger?: ServiceLogger;
  /**
   * Resolves the `ChannelManager` for a tenant. Use
   * `createTenantChannelManagers` to share one `ChannelStore` safely across
   * tenants.
   */
  channelManagers?: (tenant: TenantScope) => ChannelManager | undefined;
  /**
   * Where modules emit events. Pass `(tenant) => hub` when tenants subscribe
   * their own webhooks so one tenant's events never fan out to another's.
   */
  observability?: ObservabilitySource;
  /** Optional millisecond clock for quota enforcement in tests. */
  quotaClock?: () => number;
};

function toObservabilityResolver(
  source: ObservabilitySource | undefined,
): (tenant: TenantScope) => ObservabilitySink | undefined {
  if (source === undefined) return () => undefined;
  if (typeof source === "function") return source;
  return () => source;
}

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
  const adminStore: AdminStore = options.adminStore ?? createMemoryAdminStore(stores);
  const readinessStores = { ...stores, admin: adminStore };
  const cursors = createCursorCodec(config.cursorSecret);
  const quotas = createQuotaEnforcer({
    quotas: config.quotas,
    stores,
    ...(options.quotaClock === undefined ? {} : { now: options.quotaClock }),
  });

  const context: ServiceContext = {
    config,
    stores,
    adminStore,
    logger,
    cursors,
    quotas,
    ...(options.channelManagers === undefined ? {} : { channelManagers: options.channelManagers }),
    observabilityFor: toObservabilityResolver(options.observability),
  };

  const app = new Hono<ServiceEnv>();

  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const apiKey = c.get("apiKey");
    const operatorKey = c.get("operatorKey");
    // Only these fields are logged. Headers, including Authorization, and
    // the query string never reach a log line.
    logger.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      key: apiKey?.name ?? operatorKey?.name ?? null,
      orgId: apiKey?.orgId ?? null,
      projectId: apiKey?.projectId ?? null,
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
  app.use("/v1/*", authenticate(config.apiKeys, config.operatorKeys));

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
        const report = await checkReadiness(readinessStores, config.readinessTimeoutMs, logger);
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
      description:
        "Returns the name, owning org and project, and scopes of the key that made the request, never the key.",
      tags: ["system"],
      scope: null,
      responses: {
        200: {
          description: "The key's name, tenant and scopes.",
          schema: z.object({
            name: z.string(),
            orgId: z.string(),
            projectId: z.string(),
            scopes: z.array(z.enum(apiKeyScopes)),
          }),
        },
      },
      handler: (c) => {
        const key = requireTenantKey(c);
        return c.json({
          name: key.name,
          orgId: key.orgId,
          projectId: key.projectId,
          scopes: [...key.scopes],
        });
      },
    }),
  );

  for (const module of options.modules ?? []) routes.push(...module(context));
  mountRoutes(app, routes);
  return app;
}
