import { type CreateServiceOptions, createService, type ServiceModule } from "./app.js";
import { hashApiKey } from "./auth.js";
import { parseServiceConfig, type ServiceConfig } from "./config.js";
import type { LogFields, ServiceLogger } from "./logger.js";
import type { ServiceStores } from "./stores.js";

/** Test keys. They exist only in tests; the service is configured with their hashes. */
export const KEYS = {
  reader: "test-reader-key-0123456789abcdef",
  admin: "test-admin-key-0123456789abcdef",
  revoked: "test-revoked-key-0123456789abcdef",
  ingester: "test-ingester-key-0123456789abcdef",
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
        { name: "reader", sha256: await hashApiKey(KEYS.reader), scopes: ["read"] },
        { name: "admin", sha256: await hashApiKey(KEYS.admin), scopes: ["read", "admin"] },
        { name: "ingester", sha256: await hashApiKey(KEYS.ingester), scopes: ["ingest"] },
        {
          name: "old",
          sha256: await hashApiKey(KEYS.revoked),
          scopes: ["read", "admin"],
          revoked: true,
        },
      ]),
    },
  });
  return { ...config, ...overrides };
}

export async function testService(options?: {
  config?: Partial<ServiceConfig>;
  stores?: Partial<ServiceStores>;
  modules?: readonly ServiceModule[];
  channelManager?: CreateServiceOptions["channelManager"];
  observability?: CreateServiceOptions["observability"];
}) {
  const logger = captureLogger();
  const serviceOptions: CreateServiceOptions = {
    config: await testConfig(options?.config),
    logger,
    ...(options?.stores === undefined ? {} : { stores: options.stores }),
    ...(options?.modules === undefined ? {} : { modules: options.modules }),
    ...(options?.channelManager === undefined ? {} : { channelManager: options.channelManager }),
    ...(options?.observability === undefined ? {} : { observability: options.observability }),
  };
  return { app: createService(serviceOptions), logger };
}

export function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}
