import type { Context, Hono } from "hono";
import type { z } from "zod";
import { requireScope } from "./auth.js";
import type { ApiKeyScope } from "./config.js";
import { errorBody } from "./errors.js";
import type { ServiceEnv } from "./types.js";

/**
 * Routes are declared once, as data: the method, the path, the zod schemas
 * for the path parameters, query and body, and the response schemas. The
 * same declaration mounts the route on Hono, validates every request, and
 * produces the route's entry in `/openapi.json`, so the published spec cannot
 * drift from what the code accepts.
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

type Output<T> = T extends z.ZodType ? z.output<T> : undefined;

/** The validated request a handler receives. */
export type RouteInput<
  P extends AnyObjectSchema | undefined,
  Q extends AnyObjectSchema | undefined,
  B extends z.ZodType | undefined,
> = {
  params: Output<P>;
  query: Output<Q>;
  body: Output<B>;
};

export type RouteResponse = {
  description: string;
  /** JSON body schema. Omit for a response with no body. */
  schema?: z.ZodType;
};

export type RouteDefinition<
  P extends AnyObjectSchema | undefined,
  Q extends AnyObjectSchema | undefined,
  B extends z.ZodType | undefined,
> = {
  method: HttpMethod;
  /** OpenAPI style, for example `/v1/channels/{id}`. */
  path: string;
  summary: string;
  description?: string;
  tags?: readonly string[];
  /**
   * The scope a `/v1/*` route requires. `null` accepts any valid key. Routes
   * outside `/v1/` are public and must leave this undefined.
   */
  scope?: ApiKeyScope | null;
  request?: { params?: P; query?: Q; body?: B };
  responses: Readonly<Record<number, RouteResponse>>;
  handler: (c: Context<ServiceEnv>, input: RouteInput<P, Q, B>) => Response | Promise<Response>;
};

/** A route after {@link defineRoute}, with its input types erased. */
export type ServiceRoute = Omit<
  RouteDefinition<AnyObjectSchema | undefined, AnyObjectSchema | undefined, z.ZodType | undefined>,
  "handler"
> & {
  handler: (
    c: Context<ServiceEnv>,
    input: { params: unknown; query: unknown; body: unknown },
  ) => Response | Promise<Response>;
};

/** Declares a route, keeping the handler's input typed by its schemas. */
export function defineRoute<
  P extends AnyObjectSchema | undefined = undefined,
  Q extends AnyObjectSchema | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(definition: RouteDefinition<P, Q, B>): ServiceRoute {
  return {
    ...definition,
    // mountRoutes parses params, query and body with exactly these schemas
    // before calling the handler, so the input has the declared types.
    handler: (c, input) => definition.handler(c, input as RouteInput<P, Q, B>),
  };
}

/** Whether a path is under the authenticated `/v1/` prefix. */
export function isAuthenticatedPath(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

/** `/v1/channels/{id}` to Hono's `/v1/channels/:id`. */
export function honoPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
}

/** Checks a route declaration when the service is built, not on first request. */
export function assertRouteDeclaration(route: ServiceRoute): void {
  const where = `${route.method.toUpperCase()} ${route.path}`;
  if (!route.path.startsWith("/")) throw new Error(`${where}: the path must start with /`);
  if (isAuthenticatedPath(route.path)) {
    if (route.scope === undefined) {
      throw new Error(`${where}: a /v1 route must declare a scope, or null for any valid key`);
    }
  } else if (route.scope !== undefined) {
    throw new Error(
      `${where}: only /v1 routes are authenticated, so this route cannot set a scope`,
    );
  }
  if (route.method === "get" && route.request?.body !== undefined) {
    throw new Error(`${where}: a GET route cannot declare a body`);
  }
  const placeholders = [...route.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  const declared = Object.keys(route.request?.params?.shape ?? {});
  for (const name of placeholders) {
    if (name !== undefined && !declared.includes(name)) {
      throw new Error(`${where}: path parameter {${name}} has no schema in request.params`);
    }
  }
}

function issueDetails(error: z.ZodError, location: string) {
  return error.issues.map((issue) => ({
    location,
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/** Mounts each route with its scope check and request validation. */
export function mountRoutes(app: Hono<ServiceEnv>, routes: readonly ServiceRoute[]): void {
  for (const route of routes) {
    assertRouteDeclaration(route);
    const path = honoPath(route.path);
    const handler = async (c: Context<ServiceEnv>): Promise<Response> => {
      const request = route.request;
      let params: unknown;
      let query: unknown;
      let body: unknown;
      const problems: ReturnType<typeof issueDetails> = [];

      if (request?.params !== undefined) {
        const parsed = request.params.safeParse(c.req.param());
        if (parsed.success) params = parsed.data;
        else problems.push(...issueDetails(parsed.error, "path"));
      }
      if (request?.query !== undefined) {
        const parsed = request.query.safeParse(c.req.query());
        if (parsed.success) query = parsed.data;
        else problems.push(...issueDetails(parsed.error, "query"));
      }
      if (request?.body !== undefined) {
        let json: unknown;
        try {
          json = await c.req.json();
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return c.json(errorBody("invalid-request", "the request body is not valid JSON"), 400);
        }
        const parsed = request.body.safeParse(json);
        if (parsed.success) body = parsed.data;
        else problems.push(...issueDetails(parsed.error, "body"));
      }
      if (problems.length > 0) {
        return c.json(
          errorBody("invalid-request", "the request did not match the schema", problems),
          400,
        );
      }
      return route.handler(c, { params, query, body });
    };

    if (typeof route.scope === "string") {
      app.on(route.method.toUpperCase(), path, requireScope(route.scope), handler);
    } else {
      app.on(route.method.toUpperCase(), path, handler);
    }
  }
}
