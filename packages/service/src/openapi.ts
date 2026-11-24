import { z } from "zod";
import { errorBodySchema } from "./errors.js";
import { isAuthenticatedPath, type ServiceRoute } from "./routes.js";

/**
 * Builds the OpenAPI 3.1 document from the route declarations. Every schema
 * in it comes from the zod schema the route validates with, converted by
 * zod's own `toJSONSchema` (JSON Schema 2020-12, which OpenAPI 3.1 uses), so
 * there is no second, hand-written copy to fall out of date.
 */

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

const ERROR_REF = { $ref: "#/components/schemas/Error" };

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  });
  return rest;
}

function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ERROR_REF } } };
}

function parameters(schema: z.ZodObject<z.ZodRawShape> | undefined, location: "path" | "query") {
  if (schema === undefined) return [];
  return Object.entries(schema.shape).map(([name, field]) => {
    const fieldSchema = field as z.ZodType;
    const required = location === "path" || !fieldSchema.safeParse(undefined).success;
    const described = jsonSchema(fieldSchema, "input");
    const { description, ...rest } = described;
    return {
      name,
      in: location,
      required,
      ...(typeof description === "string" ? { description } : {}),
      schema: rest,
    };
  });
}

function operation(route: ServiceRoute): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    responses[status] =
      response.schema === undefined
        ? { description: response.description }
        : {
            description: response.description,
            content: { "application/json": { schema: jsonSchema(response.schema, "output") } },
          };
  }
  const authenticated = isAuthenticatedPath(route.path);
  if (route.request !== undefined) {
    responses["400"] ??= errorResponse("The request did not match the schema.");
  }
  if (authenticated) {
    responses["401"] ??= errorResponse("No valid API key.");
    if (typeof route.scope === "string") {
      responses["403"] ??= errorResponse(`The API key lacks the ${route.scope} scope.`);
    }
  }
  if (route.request?.body !== undefined) {
    responses["413"] ??= errorResponse("The request body is larger than the configured limit.");
  }

  const params = [
    ...parameters(route.request?.params, "path"),
    ...parameters(route.request?.query, "query"),
  ];
  return {
    operationId: `${route.method}${route.path
      .split("/")
      .filter((part) => part !== "")
      .map((part) => part.replace(/[{}]/g, ""))
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).replace(/[^A-Za-z0-9]/g, ""))
      .join("")}`,
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    ...(route.tags === undefined ? {} : { tags: [...route.tags] }),
    ...(params.length === 0 ? {} : { parameters: params }),
    ...(route.request?.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchema(route.request.body, "input") } },
          },
        }),
    ...(authenticated
      ? {
          security: [{ apiKey: [] }],
          ...(typeof route.scope === "string" ? { "x-tollway-scope": route.scope } : {}),
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(
  routes: readonly ServiceRoute[],
  version: string,
): OpenApiDocument {
  // Grouped in a Map and converted with Object.fromEntries, which defines
  // own properties. Indexing a plain object by route path would let a path
  // such as "__proto__" write to Object.prototype.
  const byPath = new Map<string, Map<string, unknown>>();
  for (const route of routes) {
    const entry = byPath.get(route.path) ?? new Map<string, unknown>();
    entry.set(route.method, operation(route));
    byPath.set(route.path, entry);
  }
  const paths: OpenApiDocument["paths"] = Object.fromEntries(
    [...byPath].map(([path, entry]) => [path, Object.fromEntries(entry)]),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "Tollway service",
      version,
      description:
        "The optional self-hosted Tollway service. Routes under /v1 require Authorization: Bearer <key>; each names the scope its key needs.",
    },
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "A service API key. The service stores only its SHA-256.",
        },
      },
      schemas: { Error: jsonSchema(errorBodySchema, "output") },
    },
  };
}
