import { readFileSync } from "node:fs";
import {
  type ConfigSources,
  parseServiceConfig,
  SERVICE_CONFIG_FILE_ENV,
  type ServiceConfig,
  ServiceConfigError,
} from "./config.js";

/**
 * Node-only configuration loading for the `tollway-service` binary: reads
 * the optional JSON file named by `TOLLWAY_SERVICE_CONFIG_FILE`, then parses
 * it together with the environment. Kept out of the library entry so route
 * code never imports `node:fs`.
 */
export function loadServiceConfig(
  env: ConfigSources["env"],
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ServiceConfig {
  const path = env[SERVICE_CONFIG_FILE_ENV];
  if (path === undefined || path === "") return parseServiceConfig({ env });

  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ServiceConfigError([
      { field: SERVICE_CONFIG_FILE_ENV, message: `cannot read ${path}: ${reason}` },
    ]);
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ServiceConfigError([
      { field: SERVICE_CONFIG_FILE_ENV, message: `${path} is not valid JSON: ${reason}` },
    ]);
  }
  return parseServiceConfig({ env, file });
}
