import { type CreateServiceOptions, createService, type ServiceModule } from "./app.js";
import { hashApiKey } from "./auth.js";
import { parseServiceConfig, type ServiceConfig } from "./config.js";
import type { LogFields, ServiceLogger } from "./logger.js";
import type { AdminStore, ServiceStores } from "./stores.js";
import type { TenantScope } from "./tenancy.js";

/** Default tenant used by single-tenant unit tests. */
export const DEFAULT_TENANT: TenantScope = {
  orgId: "org-default",
  projectId: "proj-default",
};

/** Test keys. They exist only in tests; the service is configured with their hashes. */
export const KEYS = {
  reader: "test-reader-key-0123456789abcdef",
  admin: "test-admin-key-0123456789abcdef",
  revoked: "test-revoked-key-0123456789abcdef",
  ingester: "test-ingester-key-0123456789abcdef",
  operator: "test-operator-key-0123456789abcdef",
} as const;

export type LogLine = { level: string; event: string; fields?: LogFields };

/** A logger that keeps every line, so tests can assert what was and was not logged. */
export function captureLogger(): ServiceLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push = (level: string) => (event: string, fields?: LogFields) => {
    lines.push(fields === undefined ? { level, event } : { level, event, fields });
  };
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

export async function testConfig(overrides?: Partial<ServiceConfig>): Promise<ServiceConfig> {
  const config = parseServiceConfig({
    env: {
      TOLLWAY_SERVICE_PORT: "8787",
      TOLLWAY_SERVICE_API_KEYS: JSON.stringify([
        {
          name: "reader",
          ...DEFAULT_TENANT,
          sha256: await hashApiKey(KEYS.reader),
          scopes: ["read"],
        },
        {
          name: "admin",
          ...DEFAULT_TENANT,
          sha256: await hashApiKey(KEYS.admin),
          scopes: ["read", "admin"],
        },
        {
          name: "ingester",
          ...DEFAULT_TENANT,
          sha256: await hashApiKey(KEYS.ingester),
          scopes: ["ingest"],
        },
        {
          name: "old",
          ...DEFAULT_TENANT,
          sha256: await hashApiKey(KEYS.revoked),
          scopes: ["read", "admin"],
          revoked: true,
        },
      ]),
      TOLLWAY_SERVICE_OPERATOR_KEYS: JSON.stringify([
        {
          name: "operator",
          sha256: await hashApiKey(KEYS.operator),
        },
      ]),
    },
  });
  return { ...config, ...overrides };
}

export async function testService(options?: {
  config?: Partial<ServiceConfig>;
  stores?: Partial<ServiceStores>;
  adminStore?: AdminStore;
  modules?: readonly ServiceModule[];
  channelManagers?: CreateServiceOptions["channelManagers"];
  observability?: CreateServiceOptions["observability"];
  quotaClock?: CreateServiceOptions["quotaClock"];
}) {
  const logger = captureLogger();
  const serviceOptions: CreateServiceOptions = {
    config: await testConfig(options?.config),
    logger,
    ...(options?.stores === undefined ? {} : { stores: options.stores }),
    ...(options?.adminStore === undefined ? {} : { adminStore: options.adminStore }),
    ...(options?.modules === undefined ? {} : { modules: options.modules }),
    ...(options?.channelManagers === undefined ? {} : { channelManagers: options.channelManagers }),
    ...(options?.observability === undefined ? {} : { observability: options.observability }),
    ...(options?.quotaClock === undefined ? {} : { quotaClock: options.quotaClock }),
  };
  return { app: createService(serviceOptions), logger };
}

export function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}
