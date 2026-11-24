import { enumSchema } from "@vegaforge/tollway-core";
import { z } from "zod";
import { tenantIdSchema, tenantPartitionKey } from "./tenancy.js";

/**
 * Service configuration, parsed once at startup. Values come from
 * environment variables, from a JSON config file, or both; an environment
 * variable wins over the same field in the file. A missing or malformed value
 * fails startup with a message naming the variable or field. The only
 * defaults are the ones that cannot hide a missing upstream: the listen
 * address, the readiness timeout and the body limit.
 */

/** What a tenant API key may do. Routes check one scope each; no scope implies another. */
export const apiKeyScopes = ["read", "ingest", "admin"] as const;

/** One scope granted to a tenant API key. */
export type ApiKeyScope = (typeof apiKeyScopes)[number];

const keyNameSchema = tenantIdSchema;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");

/**
 * One tenant API key. Every key is bound to one `orgId` and one `projectId`;
 * the tenant for a request comes only from the authenticated key, never from a
 * path, query or body field. Only the SHA-256 of the key is configured, never
 * the key itself, so a leaked config file or process dump does not hand over a
 * working credential. `tollway-service hash-key` prints the hash for a key.
 */
export const apiKeyConfigSchema = z.strictObject({
  /** Shown in request logs and audit records instead of the key. */
  name: keyNameSchema,
  /** Organisation that owns this key and its data. */
  orgId: tenantIdSchema,
  /** Project within the organisation that owns this key and its data. */
  projectId: tenantIdSchema,
  /** Lowercase hex SHA-256 of the key. */
  sha256: sha256Schema,
  scopes: z.array(enumSchema(apiKeyScopes)).min(1, "expected at least one scope"),
  /** A revoked key is refused with 401. Keep it listed until every client has rotated. */
  revoked: z.boolean().optional(),
});

/** Parsed configuration entry for one tenant API key. */
export type ApiKeyConfig = z.infer<typeof apiKeyConfigSchema>;

/**
 * A separately-scoped operator key for `/v1/admin/*`. Operator keys have no
 * tenant binding, cannot call tenant `/v1/*` routes, and read only the
 * cross-tenant summary exposed by `AdminStore`.
 */
export const operatorKeyConfigSchema = z.strictObject({
  name: keyNameSchema,
  sha256: sha256Schema,
  revoked: z.boolean().optional(),
});

/** Parsed configuration entry for one cross-tenant operator key. */
export type OperatorKeyConfig = z.infer<typeof operatorKeyConfigSchema>;

const quotaLimitFields = {
  /** Maximum ingested items accepted per tenant in a rolling 60-second window. */
  maxIngestItemsPerMinute: z.number().int().min(1).optional(),
  /** Maximum records retained across all stores for one tenant. */
  maxStoredRecords: z.number().int().min(1).optional(),
};

const hasAtLeastOneLimit = (quota: {
  maxIngestItemsPerMinute?: number | undefined;
  maxStoredRecords?: number | undefined;
}) => quota.maxIngestItemsPerMinute !== undefined || quota.maxStoredRecords !== undefined;

/** Schema for per-tenant ingest rate and record-count limits. */
export const tenantQuotaSchema = z
  .strictObject(quotaLimitFields)
  .refine(hasAtLeastOneLimit, "expected at least one quota limit");

/** Per-tenant ingest rate and stored-record caps. */
export type TenantQuota = z.infer<typeof tenantQuotaSchema>;

/** Schema for a quota override targeting one `(orgId, projectId)` tenant. */
export const tenantQuotaOverrideSchema = z
  .strictObject({
    orgId: tenantIdSchema,
    projectId: tenantIdSchema,
    ...quotaLimitFields,
  })
  .refine(hasAtLeastOneLimit, "expected at least one quota limit");

/** Quota override for one specific `(orgId, projectId)` tenant. */
export type TenantQuotaOverride = z.infer<typeof tenantQuotaOverrideSchema>;

/** Schema for optional default and per-tenant quota overrides. */
export const quotasConfigSchema = z
  .strictObject({
    default: tenantQuotaSchema.optional(),
    tenants: z.array(tenantQuotaOverrideSchema).optional(),
  })
  .superRefine((quotas, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of (quotas.tenants ?? []).entries()) {
      const partition = tenantPartitionKey(entry);
      if (seen.has(partition)) {
        ctx.addIssue({
          code: "custom",
          path: ["tenants", index],
          message: "duplicate tenant quota override",
        });
      }
      seen.add(partition);
    }
  });

/** Parsed quota configuration for the service. */
export type QuotasConfig = z.infer<typeof quotasConfigSchema>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function checkUniqueKeys(
  field: "apiKeys" | "operatorKeys",
  entries: readonly { name: string; sha256: string }[],
  names: Set<string>,
  hashes: Set<string>,
  ctx: z.RefinementCtx,
): void {
  for (const [index, key] of entries.entries()) {
    if (names.has(key.name)) {
      ctx.addIssue({
        code: "custom",
        path: [field, index, "name"],
        message: "duplicate key name",
      });
    }
    if (hashes.has(key.sha256)) {
      ctx.addIssue({
        code: "custom",
        path: [field, index, "sha256"],
        message: "duplicate key hash",
      });
    }
    names.add(key.name);
    hashes.add(key.sha256);
  }
}

/** Schema validating the complete `tollway-service` startup configuration. */
export const serviceConfigSchema = z
  .strictObject({
    /** TCP port the `tollway-service` binary listens on. Required. */
    port: z.number().int().min(1).max(65_535),
    /** Interface to bind. Defaults to loopback, so exposing the service is a choice. */
    host: z.string().min(1).default(DEFAULT_HOST),
    apiKeys: z.array(apiKeyConfigSchema).min(1, "expected at least one API key"),
    /** Optional operator keys for the cross-tenant `/v1/admin/*` routes. */
    operatorKeys: z.array(operatorKeyConfigSchema).optional(),
    /**
     * Optional HMAC secret (at least 32 characters) used to sign pagination
     * cursors across replicas. Single-process deployments may omit it.
     */
    cursorSecret: z.string().min(32, "expected at least 32 characters").optional(),
    /** Optional per-tenant ingest rate and record count quotas. */
    quotas: quotasConfigSchema.optional(),
    /** How long `/readyz` waits for each store before reporting it as failing. */
    readinessTimeoutMs: z.number().int().min(1).max(60_000).default(DEFAULT_READINESS_TIMEOUT_MS),
    /** Largest request body `/v1/*` accepts, in bytes. */
    maxBodyBytes: z.number().int().min(1).max(67_108_864).default(DEFAULT_MAX_BODY_BYTES),
  })
  .superRefine((config, ctx) => {
    const names = new Set<string>();
    const hashes = new Set<string>();
    checkUniqueKeys("apiKeys", config.apiKeys, names, hashes, ctx);
    checkUniqueKeys("operatorKeys", config.operatorKeys ?? [], names, hashes, ctx);
  });

/** Validated startup configuration for `createService`. */
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

type ConfigField = keyof ServiceConfig;

/** The environment variable for each field. */
export const SERVICE_ENV = {
  port: "TOLLWAY_SERVICE_PORT",
  host: "TOLLWAY_SERVICE_HOST",
  apiKeys: "TOLLWAY_SERVICE_API_KEYS",
  operatorKeys: "TOLLWAY_SERVICE_OPERATOR_KEYS",
  cursorSecret: "TOLLWAY_SERVICE_CURSOR_SECRET",
  quotas: "TOLLWAY_SERVICE_QUOTAS",
  readinessTimeoutMs: "TOLLWAY_SERVICE_READINESS_TIMEOUT_MS",
  maxBodyBytes: "TOLLWAY_SERVICE_MAX_BODY_BYTES",
} as const satisfies Record<ConfigField, string>;

/** Names a JSON config file whose fields are the {@link ServiceConfig} keys. */
export const SERVICE_CONFIG_FILE_ENV = "TOLLWAY_SERVICE_CONFIG_FILE";

const integerFields = new Set<ConfigField>(["port", "readinessTimeoutMs", "maxBodyBytes"]);
const jsonFields = new Set<ConfigField>(["apiKeys", "operatorKeys", "quotas"]);

/** One configuration problem, labelled with the variable or file field to fix. */
export type ConfigIssue = { field: string; message: string };

/** Thrown when startup configuration fails validation, listing every field issue. */
export class ServiceConfigError extends Error {
  /** Structured configuration problems reported during parsing. */
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `invalid service configuration:\n${issues.map((issue) => `  ${issue.field}: ${issue.message}`).join("\n")}`,
    );
    this.name = "ServiceConfigError";
    this.issues = issues;
  }
}

/** Raw environment and optional JSON file inputs passed to {@link parseServiceConfig}. */
export type ConfigSources = {
  /** Usually `process.env`. */
  env: Readonly<Record<string, string | undefined>>;
  /** The parsed contents of the config file, when one is used. */
  file?: unknown;
};

function fileLabel(path: readonly PropertyKey[]): string {
  let label = "";
  for (const part of path) {
    label +=
      typeof part === "number" ? `[${part}]` : label === "" ? String(part) : `.${String(part)}`;
  }
  return `config file ${label}`;
}

function envLabel(variable: string, path: readonly PropertyKey[]): string {
  if (path.length === 0) return variable;
  return `${variable} ${path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("")}`;
}

/**
 * Parses the service configuration. Throws {@link ServiceConfigError} with
 * every problem found, each naming the environment variable or file field.
 */
export function parseServiceConfig(sources: ConfigSources): ServiceConfig {
  const issues: ConfigIssue[] = [];
  const raw: Record<string, unknown> = {};
  const fromEnv = new Set<ConfigField>();

  if (sources.file !== undefined) {
    if (typeof sources.file !== "object" || sources.file === null || Array.isArray(sources.file)) {
      throw new ServiceConfigError([
        { field: SERVICE_CONFIG_FILE_ENV, message: "the config file must hold a JSON object" },
      ]);
    }
    Object.assign(raw, sources.file);
  }

  for (const [field, variable] of Object.entries(SERVICE_ENV) as [ConfigField, string][]) {
    const value = sources.env[variable];
    if (value === undefined || value === "") continue;
    fromEnv.add(field);
    if (integerFields.has(field)) {
      if (!/^[0-9]+$/.test(value.trim())) {
        issues.push({ field: variable, message: `expected a whole number, got "${value}"` });
        continue;
      }
      raw[field] = Number(value.trim());
    } else if (jsonFields.has(field)) {
      try {
        raw[field] = JSON.parse(value);
      } catch {
        // Key lists can carry secret-adjacent material: name the variable,
        // never echo its contents.
        issues.push({ field: variable, message: "is not valid JSON" });
      }
    } else {
      raw[field] = value;
    }
  }

  const parsed = serviceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, ...rest] = issue.path;
      const field = head as ConfigField | undefined;
      // A field that already failed to parse from its variable is reported once.
      if (field !== undefined && issues.some((known) => known.field === SERVICE_ENV[field])) {
        continue;
      }
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          issues.push({ field: fileLabel([...issue.path, key]), message: "unknown field" });
        }
        continue;
      }
      let label: string;
      if (field !== undefined && fromEnv.has(field)) {
        label = envLabel(SERVICE_ENV[field], rest);
      } else if (field !== undefined && field in raw) {
        label = fileLabel(issue.path);
      } else if (field !== undefined && field in SERVICE_ENV) {
        label = `${SERVICE_ENV[field]} (or "${field}" in the config file)`;
      } else {
        label = fileLabel(issue.path);
      }
      const message =
        field !== undefined && !(field in raw) && issue.code === "invalid_type"
          ? "is required"
          : issue.message;
      issues.push({ field: label, message });
    }
  }

  if (issues.length > 0 || !parsed.success) throw new ServiceConfigError(issues);
  return parsed.data;
}
