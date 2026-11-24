#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createService } from "./app.js";
import { hashApiKey } from "./auth.js";
import { ServiceConfigError } from "./config.js";
import { createConsoleLogger, describeError } from "./logger.js";
import { metricsModule } from "./metrics.js";
import { loadServiceConfig } from "./node-config.js";

/**
 * The `tollway-service` command.
 *
 *   tollway-service            start the service from the environment
 *   tollway-service hash-key   read a key on stdin, print the sha256 to configure
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function hashKeyCommand(): Promise<void> {
  // The key comes on stdin rather than as an argument, so it never lands in
  // shell history or the process list.
  const key = (await readStdin()).replace(/\r?\n$/, "");
  if (key === "") {
    console.error("tollway-service hash-key: pass the key on stdin");
    process.exitCode = 1;
    return;
  }
  console.log(await hashApiKey(key));
}

function startCommand(): void {
  const logger = createConsoleLogger();
  const config = loadServiceConfig(process.env);
  // The metrics routes (#226) are the service's first module.
  const app = createService({ config, logger, modules: [metricsModule()] });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info("listening", { host: config.host, port: info.port });
  });
  const shutdown = (signal: string) => {
    logger.info("shutting-down", { signal });
    server.close((error) => {
      if (error) {
        logger.error("shutdown-failed", describeError(error));
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[2];
  if (command === "hash-key") return hashKeyCommand();
  if (command !== undefined) {
    console.error(`tollway-service: unknown command "${command}". Commands: hash-key`);
    process.exitCode = 1;
    return;
  }
  startCommand();
}

main(process.argv).catch((error: unknown) => {
  if (error instanceof ServiceConfigError) {
    // A configuration problem is the operator's to fix: list it, no stack.
    console.error(error.message);
  } else {
    console.error("tollway-service failed:", error);
  }
  process.exitCode = 1;
});
