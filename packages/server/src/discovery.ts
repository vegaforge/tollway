/**
 * x402 Bazaar discovery (issue #154): a paywalled route can describe itself
 * so a facilitator that runs a catalogue can list it. See
 * apps/web/src/content/docs/discovery.mdx.
 *
 * Publishing is the operator's choice. A route without a `discovery` block
 * declares nothing. With one, the 402 challenge carries `extensions.bazaar`,
 * built by `declareDiscoveryExtension` from `@x402/extensions` and enriched
 * by its `bazaarResourceServerExtension` with the request method and route
 * template. The x402 client echoes the challenge's `resource` and
 * `extensions` into the payment payload, and `createHttpFacilitator`
 * forwards that payload unchanged to `/verify` and `/settle`, which is where
 * a cataloguing facilitator reads it with `extractDiscoveryInfo`.
 *
 * Tollway does not run or emulate a catalogue: it is not a facilitator.
 */

import { TollwayError } from "@vegaforge/tollway-core";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceInfo } from "@x402/core/types";
import {
  bazaarResourceServerExtension,
  type DeclareDiscoveryExtensionInput,
  type DiscoveryExtension,
  declareDiscoveryExtension,
  isValidRouteTemplate,
  type ListDiscoveryResourcesParams,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
  withBazaar,
} from "@x402/extensions/bazaar";
import { z } from "zod";
import type { HttpFacilitatorOptions } from "./facilitator.js";

type DiscoveryShape = {
  /** Example input: query parameters for a query route, the body for a body route. */
  input?: Record<string, unknown>;
  /** JSON Schema for `input`. */
  inputSchema?: Record<string, unknown>;
  /** Example path parameters. Never values that identify a user. */
  pathParams?: Record<string, unknown>;
  pathParamsSchema?: Record<string, unknown>;
  output?: { example?: unknown; schema?: Record<string, unknown> };
  /**
   * The route as a template with `:param` segments, for example
   * `/weather/:city`. A facilitator catalogues the template, not the path a
   * payer happened to request, so user-identifying path segments must be
   * parameters. Checked with `isValidRouteTemplate` from `@x402/extensions`.
   */
  routeTemplate?: string;
  /** Human-readable description, published as `resource.description`. */
  description?: string;
  /** MIME type of the response, published as `resource.mimeType`. */
  mimeType?: string;
};

/**
 * A route's discovery declaration. `query` routes take their input from the
 * query string (GET, HEAD, DELETE); `body` routes from a request body (POST,
 * PUT, PATCH). The HTTP method itself is not declared: the upstream
 * enrichment takes it from the request, as `@x402/extensions` intends.
 */
export type DiscoveryDeclaration =
  | ({ kind: "query" } & DiscoveryShape)
  | ({ kind: "body"; bodyType: "json" | "form-data" | "text" } & DiscoveryShape);

function toDeclareInput(declaration: DiscoveryDeclaration): DeclareDiscoveryExtensionInput {
  const shared = {
    ...(declaration.input === undefined ? {} : { input: declaration.input }),
    ...(declaration.inputSchema === undefined ? {} : { inputSchema: declaration.inputSchema }),
    ...(declaration.pathParams === undefined ? {} : { pathParams: declaration.pathParams }),
    ...(declaration.pathParamsSchema === undefined
      ? {}
      : { pathParamsSchema: declaration.pathParamsSchema }),
    ...(declaration.output === undefined ? {} : { output: declaration.output }),
  };
  return declaration.kind === "body" ? { ...shared, bodyType: declaration.bodyType } : shared;
}

/**
 * The bazaar extension for one request: declared, then enriched with the
 * request's method and the route template exactly as the upstream resource
 * server would.
 */
function enrichedExtension(
  declaration: DiscoveryDeclaration,
  request: { method: string; path: string },
): DiscoveryExtension {
  const declared = declareDiscoveryExtension(toDeclareInput(declaration)).bazaar;
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (declared === undefined || enrich === undefined) {
    throw new TollwayError(
      "invalid-discovery",
      "@x402/extensions did not produce a bazaar declaration to publish",
    );
  }
  const enriched = enrich(declared, {
    method: request.method,
    adapter: { getPath: () => request.path },
    ...(declaration.routeTemplate === undefined ? {} : { routePattern: declaration.routeTemplate }),
  }) as DiscoveryExtension;
  return withoutRequestPathValues(enriched, declaration.pathParams);
}

/**
 * The upstream enrichment copies the values this request's path held into
 * `info.input.pathParams`, as an example for the catalogue. The facilitator
 * receives them with the payment, so a route like `/users/:userId` would
 * hand it the payer's own id. Tollway publishes the operator's declared
 * example instead, or no example at all: the template already says which
 * segments are parameters.
 */
function withoutRequestPathValues(
  extension: DiscoveryExtension,
  declared: Record<string, unknown> | undefined,
): DiscoveryExtension {
  const { pathParams: _fromRequest, ...input } = extension.info.input as Record<string, unknown>;
  return {
    ...extension,
    info: {
      ...extension.info,
      input: { ...input, ...(declared === undefined ? {} : { pathParams: declared }) },
    },
  } as DiscoveryExtension;
}

/**
 * Refuses a declaration that would publish an invalid extension, when the
 * paywall is created rather than on the first 402. It checks the route
 * template, then runs both upstream validators over the enriched extension:
 * the protocol rules (`validateDiscoveryExtensionSpec`) and the info against
 * its own schema (`validateDiscoveryExtension`). The enrichment uses the
 * route's own method kind and template, which is what every real request
 * produces.
 */
export function checkDiscoveryDeclaration(declaration: DiscoveryDeclaration): void {
  if (declaration.routeTemplate !== undefined && !isValidRouteTemplate(declaration.routeTemplate)) {
    throw new TollwayError(
      "invalid-discovery",
      `discovery.routeTemplate "${declaration.routeTemplate}" is not a valid route template: use a path of /segments and :params, with no .. or ://`,
    );
  }
  const extension = enrichedExtension(declaration, {
    method: declaration.kind === "body" ? "POST" : "GET",
    path: declaration.routeTemplate ?? "/",
  });
  const problems = [
    ...(validateDiscoveryExtensionSpec(extension as unknown as Record<string, unknown>).errors ??
      []),
    ...(validateDiscoveryExtension(extension).errors ?? []),
  ];
  if (problems.length > 0) {
    throw new TollwayError(
      "invalid-discovery",
      `invalid Bazaar discovery declaration: ${problems.join("; ")}`,
    );
  }
}

/** The `extensions` a 402 carries for a route that declares discovery. */
export function discoveryExtensions(
  declaration: DiscoveryDeclaration,
  request: { method: string; url: string },
): Record<string, unknown> {
  const path = new URL(request.url, "http://localhost").pathname;
  return { bazaar: enrichedExtension(declaration, { method: request.method, path }) };
}

/** The `resource` fields a declaration adds to the challenge. */
export function discoveryResourceInfo(
  declaration: DiscoveryDeclaration,
): Pick<ResourceInfo, "description" | "mimeType"> {
  return {
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    ...(declaration.mimeType === undefined ? {} : { mimeType: declaration.mimeType }),
  };
}

// ── Reading a facilitator's catalogue ──────────────────────────────────────

const requirementSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  amount: z.string(),
  asset: z.string(),
  payTo: z.string(),
});

const catalogueSchema = z.object({
  x402Version: z.number().int(),
  items: z.array(
    z.object({
      resource: z.string().min(1),
      type: z.string(),
      x402Version: z.number().int(),
      accepts: z.array(requirementSchema),
      lastUpdated: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      extensions: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  pagination: z.object({
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

/** One page of a facilitator's Bazaar catalogue, as Tollway reads it. */
export type DiscoveryCatalogue = z.infer<typeof catalogueSchema>;

/**
 * Lists one page of a facilitator's Bazaar catalogue
 * (`GET <facilitator>/discovery/resources`) through `withBazaar` from
 * `@x402/extensions`. The response is external input, so it is parsed with a
 * schema; a malformed one throws `facilitator-invalid-response` naming the
 * field, rather than reaching the caller half-checked.
 */
export async function listDiscoveryResources(
  facilitatorUrl: string,
  options: {
    params?: ListDiscoveryResourcesParams;
    /** The same auth hook `createHttpFacilitator` takes. */
    createAuthHeaders?: HttpFacilitatorOptions["createAuthHeaders"];
  } = {},
): Promise<DiscoveryCatalogue> {
  const client = withBazaar(
    new HTTPFacilitatorClient({
      url: facilitatorUrl,
      ...(options.createAuthHeaders === undefined
        ? {}
        : { createAuthHeaders: options.createAuthHeaders }),
    }),
  );
  const raw: unknown = await client.extensions.bazaar.listResources(options.params);
  const parsed = catalogueSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new TollwayError(
      "facilitator-invalid-response",
      `${facilitatorUrl}/discovery/resources answered with an invalid catalogue at ${where}: ${issue?.message ?? "unknown problem"}`,
    );
  }
  return parsed.data;
}
