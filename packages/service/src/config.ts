import { z } from "zod";

/**
 * Service configuration, parsed once at startup. Values come from
 * environment variables, from a JSON config file, or both; an environment
 * variable wins over the same field in the file. A missing or malformed value
 * fails startup with a message naming the variable or field. The only
 * defaults are the ones that cannot hide a missing upstream: the listen
 * address, the readiness timeout and the body limit.
 */

/** What an API key may do. Routes check one scope each; no scope implies another. */
export const apiKeyScopes = ["read", "ingest", "admin"] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

/**
 * One API key. Only the SHA-256 of the key is configured, never the key
 * itself, so a leaked config file or process dump does not hand over a
 * working credential. `tollway-service hash-key` prints the hash for a key.
 */
export const apiKeyConfigSchema = z.strictObject({
  /** Shown in request logs and audit records instead of the key. */
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9._-]{1,64}$/,
      "expected 1 to 64 letters, digits, dots, dashes or underscores",
    ),
  /** Lowercase hex SHA-256 of the key. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters"),
  scopes: z.array(z.enum(apiKeyScopes)).min(1, "expected at least one scope"),
  /** A revoked key is refused with 401. Keep it listed until every client has rotated. */
  revoked: z.boolean().optional(),
});

export type ApiKeyConfig = z.infer<typeof apiKeyConfigSchema>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export const serviceConfigSchema = z.strictObject({
  /** TCP port the `tollway-service` binary listens on. Required. */
  port: z.number().int().min(1).max(65_535),
  /** Interface to bind. Defaults to loopback, so exposing the service is a choice. */
  host: z.string().min(1).default(DEFAULT_HOST),
  apiKeys: z
    .array(apiKeyConfigSchema)
    .min(1, "expected at least one API key")
    .superRefine((keys, ctx) => {
      const names = new Set<string>();
      const hashes = new Set<string>();
      for (const [index, key] of keys.entries()) {
        if (names.has(key.name)) {
          ctx.addIssue({ code: "custom", path: [index, "name"], message: "duplicate key name" });
        }
        if (hashes.has(key.sha256)) {
          ctx.addIssue({ code: "custom", path: [index, "sha256"], message: "duplicate key hash" });
        }
        names.add(key.name);
        hashes.add(key.sha256);
      }
    }),
  /** How long `/readyz` waits for each store before reporting it as failing. */
  readinessTimeoutMs: z.number().int().min(1).max(60_000).default(DEFAULT_READINESS_TIMEOUT_MS),
  /** Largest request body `/v1/*` accepts, in bytes. */
  maxBodyBytes: z.number().int().min(1).max(67_108_864).default(DEFAULT_MAX_BODY_BYTES),
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

type ConfigField = keyof ServiceConfig;

/** The environment variable for each field. */
export const SERVICE_ENV = {
  port: "TOLLWAY_SERVICE_PORT",
  host: "TOLLWAY_SERVICE_HOST",
  apiKeys: "TOLLWAY_SERVICE_API_KEYS",
  readinessTimeoutMs: "TOLLWAY_SERVICE_READINESS_TIMEOUT_MS",
  maxBodyBytes: "TOLLWAY_SERVICE_MAX_BODY_BYTES",
} as const satisfies Record<ConfigField, string>;

/** Names a JSON config file whose fields are the {@link ServiceConfig} keys. */
export const SERVICE_CONFIG_FILE_ENV = "TOLLWAY_SERVICE_CONFIG_FILE";

const integerFields = new Set<ConfigField>(["port", "readinessTimeoutMs", "maxBodyBytes"]);

/** One configuration problem, labelled with the variable or file field to fix. */
export type ConfigIssue = { field: string; message: string };

export class ServiceConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `invalid service configuration:\n${issues.map((issue) => `  ${issue.field}: ${issue.message}`).join("\n")}`,
    );
    this.name = "ServiceConfigError";
    this.issues = issues;
  }
}

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
    } else if (field === "apiKeys") {
      try {
        raw[field] = JSON.parse(value);
      } catch {
        // The value is a secret-adjacent list of hashes: name the variable,
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
