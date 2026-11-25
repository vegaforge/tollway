#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { run } from "./run.js";

/** The `tollway` binary: wires the command to the real process. */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  readFile: (path) => readFile(path, "utf8"),
  fetch: globalThis.fetch,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // run() answers every failure with an exit code; reaching here is a bug.
    process.stderr.write(`tollway: unexpected failure: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
