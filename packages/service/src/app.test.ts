import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ServiceModule } from "./app.js";
import { createService } from "./app.js";
import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.js";
import { defineRoute } from "./routes.js";
import { createMemoryReceiptStore } from "./stores.js";
import { bearer, captureLogger, KEYS, testConfig, testService } from "./test-support.js";

const echoModule: ServiceModule = () => [
  defineRoute({
    method: "post",
    path: "/v1/echo/{name}",
    summary: "Echo",
    scope: "read",
    request: {
      params: z.object({ name: z.string().min(1) }),
      query: z.object({ times: z.coerce.number().int().min(1).max(3).optional() }),
      body: z.object({ amount: z.string().regex(/^[0-9]+$/) }),
    },
    responses: {
      200: { description: "Echoed.", schema: z.object({ name: z.string(), amount: z.string() }) },
    },
    handler: (c, { params, query, body }) =>
      c.json({ name: params.name.repeat(query.times ?? 1), amount: body.amount }),
  }),
  defineRoute({
    method: "get",
    path: "/v1/boom",
    summary: "Fails",
    scope: null,
    responses: { 200: { description: "Never." } },
    handler: () => {
      throw new Error("database password=hunter2 rejected");
    },
  }),
];

function post(body: string) {
  return {
    method: "POST",
    headers: { ...bearer(KEYS.reader), "Content-Type": "application/json" },
    body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health and readiness", () => {
  it("answers /healthz without a key and without touching a store", async () => {
    const check = vi.fn(async () => {});
    const receipts = { ...createMemoryReceiptStore(), check };
    const { app } = await testService({ stores: { receipts } });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(check).not.toHaveBeenCalled();
  });

  it("reports every store as ok on /readyz", async () => {
    const { app } = await testService();
    const response = await app.request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      stores: {
        receipts: { status: "ok" },
        metrics: { status: "ok" },
        channels: { status: "ok" },
        policies: { status: "ok" },
      },
    });
  });

  it("answers 503 and names a failing store, without leaking its error", async () => {
    const receipts = {
      ...createMemoryReceiptStore(),
      check: async () => {
        throw new Error("connect ECONNREFUSED postgres://admin:s3cret@db:5432");
      },
    };
    const { app, logger } = await testService({ stores: { receipts } });
    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("s3cret");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "not-ready",
        message: "a backing store is not ready",
        details: {
          status: "not-ready",
          stores: {
            receipts: { status: "failing", reason: "error" },
            metrics: { status: "ok" },
            channels: { status: "ok" },
            policies: { status: "ok" },
          },
        },
      },
    });
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: "warn", event: "store-not-ready" }),
    );
  });

  it("reports a store that does not answer in time as failing", async () => {
    const receipts = { ...createMemoryReceiptStore(), check: () => new Promise<void>(() => {}) };
    const { app } = await testService({ stores: { receipts }, config: { readinessTimeoutMs: 20 } });
    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.details.stores.receipts).toEqual({ status: "failing", reason: "timeout" });
  });
});

describe("/openapi.json", () => {
  it("lists every mounted route, and only those", async () => {
    const { app } = await testService({ modules: [echoModule] });
    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const document = (await response.json()) as OpenApiDocument;

    // Hono records app-wide middleware as method ALL, and lists a route once
    // per handler in its chain (the scope check, then the route), so collect
    // distinct method and path pairs.
    const mounted = [
      ...new Set(
        app.routes
          .filter((route) => route.method !== "ALL")
          .map((route) => `${route.method} ${route.path}`),
      ),
    ].sort();
    const documented = Object.entries(document.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations).map(
          (method) => `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`,
        ),
      )
      .sort();
    expect(documented).toEqual(mounted);
    expect(documented).toEqual([
      "GET /healthz",
      "GET /openapi.json",
      "GET /readyz",
      "GET /v1/boom",
      "GET /v1/whoami",
      "POST /v1/echo/:name",
    ]);
  });

  it("describes a route from the same schemas that validate it", async () => {
    const { app } = await testService({ modules: [echoModule] });
    const document = (await (await app.request("/openapi.json")).json()) as OpenApiDocument;
    const echo = document.paths["/v1/echo/{name}"]?.post as Record<string, unknown>;
    expect(document.openapi).toBe("3.1.0");
    expect(echo.security).toEqual([{ apiKey: [] }]);
    expect(echo["x-tollway-scope"]).toBe("read");
    expect(echo.parameters).toEqual([
      { name: "name", in: "path", required: true, schema: { type: "string", minLength: 1 } },
      {
        name: "times",
        in: "query",
        required: false,
        schema: expect.objectContaining({ type: "integer", minimum: 1, maximum: 3 }),
      },
    ]);
    expect(echo.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: expect.objectContaining({
            properties: { amount: { type: "string", pattern: "^[0-9]+$" } },
            required: ["amount"],
          }),
        },
      },
    });
    expect(Object.keys(echo.responses as object).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "413",
    ]);
  });
});

describe("request validation and errors", () => {
  it("validates path, query and body and passes typed values to the handler", async () => {
    const { app } = await testService({ modules: [echoModule] });
    const response = await app.request("/v1/echo/ab?times=2", post('{"amount":"10"}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "abab", amount: "10" });
  });

  it("answers 400 with every failing field", async () => {
    const { app } = await testService({ modules: [echoModule] });
    const response = await app.request("/v1/echo/ab?times=9", post('{"amount":"1.5"}'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid-request");
    expect(body.error.details).toEqual([
      expect.objectContaining({ location: "query", path: "times" }),
      expect.objectContaining({ location: "body", path: "amount" }),
    ]);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const { app } = await testService({ modules: [echoModule] });
    const response = await app.request("/v1/echo/ab", post("{not json"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-request");
  });

  it("answers 413 for a body over the limit", async () => {
    const { app } = await testService({ modules: [echoModule], config: { maxBodyBytes: 32 } });
    const response = await app.request(
      "/v1/echo/ab",
      post(JSON.stringify({ amount: "1".repeat(64) })),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("payload-too-large");
  });

  it("answers 404 in the error shape", async () => {
    const { app } = await testService();
    const response = await app.request("/nothing-here");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "no route for GET /nothing-here" },
    });
  });

  it("answers 500 without the internal message, and logs it", async () => {
    const { app, logger } = await testService({ modules: [echoModule] });
    const response = await app.request("/v1/boom", { headers: bearer(KEYS.reader) });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text).error.code).toBe("internal-error");
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: "error", event: "unhandled-error" }),
    );
  });
});

describe("route declarations", () => {
  it("refuses a /v1 route without a scope, and a public route with one", async () => {
    const config = await testConfig();
    const logger = captureLogger();
    const unscoped: ServiceModule = () => [
      defineRoute({
        method: "get",
        path: "/v1/open",
        summary: "x",
        responses: { 200: { description: "x" } },
        handler: (c) => c.json({}),
      }),
    ];
    const scopedPublic: ServiceModule = () => [
      defineRoute({
        method: "get",
        path: "/public",
        summary: "x",
        scope: "read",
        responses: { 200: { description: "x" } },
        handler: (c) => c.json({}),
      }),
    ];
    expect(() => createService({ config, logger, modules: [unscoped] })).toThrow(
      /must declare a scope/,
    );
    expect(() => createService({ config, logger, modules: [scopedPublic] })).toThrow(
      /cannot set a scope/,
    );
  });
});

describe("trust boundary", () => {
  it("makes no outbound network call on any route", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("the service must not call out");
    });
    vi.stubGlobal("fetch", fetchStub);

    const { app } = await testService({ modules: [echoModule] });
    const requests: [string, RequestInit?][] = [
      ["/healthz"],
      ["/readyz"],
      ["/openapi.json"],
      ["/v1/whoami", { headers: bearer(KEYS.reader) }],
      ["/v1/whoami"],
      ["/v1/echo/a", post('{"amount":"1"}')],
      ["/v1/boom", { headers: bearer(KEYS.reader) }],
      ["/missing"],
    ];
    for (const [path, init] of requests) {
      const response = await app.request(path, init);
      expect(response.status).toBeLessThan(600);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("buildOpenApiDocument", () => {
  it("keeps a route path such as __proto__ an own property of the document", () => {
    // Regression lock for a CodeQL prototype-polluting-assignment finding:
    // paths were grouped by indexing a plain object with the route path.
    const probe = defineRoute({
      method: "get",
      path: "__proto__",
      summary: "Pollution probe",
      responses: { 200: { description: "Unused.", schema: z.object({}) } },
      handler: (c) => c.json({}),
    });
    const document = buildOpenApiDocument([probe], "0.0.0");

    expect(Object.hasOwn(document.paths, "__proto__")).toBe(true);
    expect(Object.keys(document.paths)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).get).toBeUndefined();
    expect(Object.getPrototypeOf(document.paths)).toBe(Object.prototype);
  });
});
