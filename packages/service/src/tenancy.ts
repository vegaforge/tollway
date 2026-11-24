import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  type JsonValue,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import { z } from "zod";

/**
 * First-class multi-tenancy primitives (#231): tenant identifiers, composite
 * partition keys, constant-time string comparison, and HMAC-SHA256 pagination
 * cursors bound to `(orgId, projectId, route, query)`.
 *
 * Nothing here imports Node-only modules, so the service runs identically on
 * Node and Fetch-compatible edge runtimes.
 */

/** Identifier format shared by `orgId`, `projectId` and API key names. */
export const tenantIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "expected 1 to 64 letters, digits, dots, dashes or underscores");

/** Reusable optional `orgId` and `projectId` schema fields for ingest payloads. */
export const tenantClaimFields = {
  orgId: tenantIdSchema.optional(),
  projectId: tenantIdSchema.optional(),
} as const;

/** Zod schema for the `{ orgId, projectId }` scope required on every tenant store call. */
export const tenantScopeSchema = z.strictObject({
  orgId: tenantIdSchema,
  projectId: tenantIdSchema,
});

/** Owning organisation and project for a tenant key or stored record. */
export type TenantScope = z.infer<typeof tenantScopeSchema>;

/** Optional tenant fields an ingest item or batch envelope may declare. */
export type TenantClaim = {
  orgId?: string | undefined;
  projectId?: string | undefined;
};

/**
 * True when an optional tenant claim does not contradict the authenticated
 * key's tenant. Any present field that differs is a cross-tenant claim.
 */
export function matchesTenantClaim(tenant: TenantScope, claim: TenantClaim): boolean {
  if (claim.orgId !== undefined && claim.orgId !== tenant.orgId) return false;
  if (claim.projectId !== undefined && claim.projectId !== tenant.projectId) return false;
  return true;
}

/**
 * Length-prefixed partition key for `(orgId, projectId)`. Prefixing each part
 * with its length prevents delimiter collisions such as `("a:b", "c")` and
 * `("a", "b:c")`.
 */
export function tenantPartitionKey(tenant: TenantScope): string {
  return `${tenant.orgId.length}:${tenant.orgId}:${tenant.projectId.length}:${tenant.projectId}`;
}

/** Length-prefixed composite key for `(orgId, projectId, id)`. */
export function scopedRecordKey(tenant: TenantScope, id: string): string {
  return `${tenantPartitionKey(tenant)}:${id.length}:${id}`;
}

/** Compares two strings without an early exit. */
export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  }
  return difference === 0;
}

/** Signs and verifies opaque pagination cursors bound to a tenant and query. */
export interface CursorCodec {
  /** Produces an HMAC-SHA256 signed cursor bound to `tenant`, `route` and `query`. */
  sign(tenant: TenantScope, route: string, query: JsonValue, payload: string): Promise<string>;
  /** Verifies `cursor` against `tenant`, `route` and `query`, returning the inner payload or `undefined`. */
  verify(
    tenant: TenantScope,
    route: string,
    query: JsonValue,
    cursor: string,
  ): Promise<string | undefined>;
}

const CURSOR_TOKEN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function cursorMacInput(
  tenant: TenantScope,
  route: string,
  query: JsonValue,
  payloadSegment: string,
): Uint8Array {
  return utf8Bytes(
    canonicalJson({
      v: 1,
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      route,
      query,
      payload: payloadSegment,
    }),
  );
}

/**
 * Creates an HMAC-SHA256 cursor codec. Multi-replica deployments pass the
 * shared `cursorSecret` from `ServiceConfig`; single-process deployments that
 * omit it get a fresh random 256-bit secret per service instance.
 */
export function createCursorCodec(secret?: string): CursorCodec {
  const rawSecret = secret ?? randomSecret();
  let keyPromise: Promise<CryptoKey> | undefined;

  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle.importKey(
      "raw",
      utf8Bytes(rawSecret) as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return keyPromise;
  };

  const computeMac = async (
    tenant: TenantScope,
    route: string,
    query: JsonValue,
    payloadSegment: string,
  ): Promise<string> => {
    const key = await getKey();
    const input = cursorMacInput(tenant, route, query, payloadSegment);
    const mac = await crypto.subtle.sign("HMAC", key, input as Uint8Array<ArrayBuffer>);
    return bytesToBase64Url(new Uint8Array(mac));
  };

  return {
    async sign(tenant, route, query, payload) {
      const payloadSegment = bytesToBase64Url(utf8Bytes(payload));
      const macSegment = await computeMac(tenant, route, query, payloadSegment);
      return `${payloadSegment}.${macSegment}`;
    },
    async verify(tenant, route, query, cursor) {
      const match = CURSOR_TOKEN.exec(cursor);
      const payloadSegment = match?.[1];
      const presentedMac = match?.[2];
      if (payloadSegment === undefined || presentedMac === undefined) return undefined;

      const expectedMac = await computeMac(tenant, route, query, payloadSegment);
      // Verify the MAC in constant time before decoding caller-supplied bytes.
      if (!constantTimeEqual(expectedMac, presentedMac)) return undefined;

      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(
          base64UrlToBytes(payloadSegment),
        );
      } catch {
        return undefined;
      }
      if (bytesToBase64Url(utf8Bytes(decoded)) !== payloadSegment) return undefined;
      return decoded;
    },
  };
}
