import { parseArgs } from "node:util";
import type { KeySetFetcher } from "@vegaforge/tollway-core";
import { decodeValue, SHAPE_NAMES } from "./decode.js";
import { inspect } from "./inspect.js";
import { summarisePayment } from "./summary.js";
import { readReceipt, verifierFromJwks, verifierFromKeysFile, verify } from "./verify.js";

/**
 * The `tollway` command. Read-only: it decodes, verifies and inspects, and
 * has no option that takes a secret key or makes a payment.
 *
 * Exit codes: 0 ok, 1 a value failed to decode, validate or verify (or the
 * URL is not a paid route), 2 a usage error.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** What the command reads and writes, injected so tests need no process. */
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  fetch: typeof fetch;
  /** Used by `verify --jwks`; defaults to `fetch`. */
  keySetFetch?: KeySetFetcher;
};

export const USAGE = `Usage: tollway <command> [options]

Commands:
  decode <value | ->          Decode a PAYMENT-REQUIRED, PAYMENT-SIGNATURE,
                              PAYMENT-RESPONSE or TOLLWAY-RECEIPT value
  verify <file | ->           Verify a signed receipt (JSON or header value)
      --keys <file>           Key-set document, or a map of key id to key
      --jwks <url>            URL of a published key set
  inspect <url>               Send one unpaid request and explain the 402
      --method <method>       HTTP method (default GET)
      --header <k:v>          Request header, repeatable
      --timeout <ms>          Give up after this long (default 10000)

Options for every command:
  --json                      Machine-readable output
  --raw                       decode: print a PAYMENT-SIGNATURE in full
  -h, --help                  Show this help

Exit codes: 0 ok, 1 decode, validation or verification failure, 2 usage error.
`;

class UsageError extends Error {}

async function readInput(argument: string | undefined, io: Io, what: string): Promise<string> {
  if (argument === undefined) throw new UsageError(`${what}: missing argument`);
  return argument === "-" ? io.readStdin() : argument;
}

function print(io: Io, json: boolean, data: unknown, lines: string[]): void {
  io.stdout(json ? `${JSON.stringify(data, null, 2)}\n` : `${lines.join("\n")}\n`);
}

async function decodeCommand(
  positionals: string[],
  flags: { json: boolean; raw: boolean },
  io: Io,
): Promise<number> {
  const decoded = decodeValue(await readInput(positionals[0], io, "decode"));
  const name = SHAPE_NAMES[decoded.shape];
  if (decoded.shape === "x402-payment-payload" && !flags.raw) {
    const summary = await summarisePayment(decoded);
    print(io, flags.json, { encoding: decoded.encoding, shape: decoded.shape, summary }, [
      `${name} (${decoded.encoding})`,
      `  scheme   ${summary.scheme}`,
      `  network  ${summary.network}`,
      `  amount   ${summary.amount}`,
      `  asset    ${summary.asset}`,
      `  payTo    ${summary.payTo}`,
      `  payer    ${summary.payer ?? `unknown (${summary.payerUnknown})`}`,
      "  The signed transaction envelope is hidden; pass --raw to print it.",
    ]);
    return EXIT_OK;
  }
  print(io, flags.json, decoded, [
    `${name} (${decoded.encoding})`,
    JSON.stringify(decoded.value, null, 2),
  ]);
  return EXIT_OK;
}

async function verifyCommand(
  positionals: string[],
  flags: { json: boolean; keys?: string; jwks?: string },
  io: Io,
): Promise<number> {
  if ((flags.keys === undefined) === (flags.jwks === undefined)) {
    throw new UsageError("verify: pass exactly one of --keys <file> and --jwks <url>");
  }
  const source = positionals[0];
  if (source === undefined) throw new UsageError("verify: missing receipt file (or - for stdin)");
  const receipt = readReceipt(source === "-" ? await io.readStdin() : await io.readFile(source));
  const verifier =
    flags.keys !== undefined
      ? verifierFromKeysFile(await io.readFile(flags.keys))
      : verifierFromJwks(flags.jwks as string, io.keySetFetch);
  const result = await verify(receipt, verifier);
  if (result.valid) {
    print(io, flags.json, { valid: true, keyId: result.keyId }, [
      `valid: signed by ${result.keyId}`,
    ]);
    return EXIT_OK;
  }
  print(io, flags.json, { valid: false, keyId: result.keyId, reason: result.reason }, [
    `invalid: ${result.reason}`,
  ]);
  return EXIT_FAILURE;
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf(":");
    if (index <= 0) throw new UsageError(`inspect: --header must be name:value, got "${value}"`);
    headers[value.slice(0, index).trim()] = value.slice(index + 1).trim();
  }
  return headers;
}

async function inspectCommand(
  positionals: string[],
  flags: { json: boolean; method?: string; header: string[]; timeout?: string },
  io: Io,
): Promise<number> {
  const target = positionals[0];
  if (target === undefined) throw new UsageError("inspect: missing URL");
  let timeoutMs: number | undefined;
  if (flags.timeout !== undefined) {
    timeoutMs = Number(flags.timeout);
    if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
      throw new UsageError(`inspect: --timeout must be a positive integer, got ${flags.timeout}`);
    }
  }
  const result = await inspect(target, {
    ...(flags.method === undefined ? {} : { method: flags.method.toUpperCase() }),
    headers: parseHeaders(flags.header),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fetch: io.fetch,
  });
  if (!result.paid) {
    print(io, flags.json, result, [
      `${result.url} answered ${result.status}, not 402: it did not ask for payment`,
    ]);
    return EXIT_FAILURE;
  }
  const lines = [`${result.url} asks for payment (402)`];
  if (result.resource !== undefined) lines.push(`  resource     ${result.resource}`);
  lines.push(`  models       ${result.models.join(", ")}`);
  lines.push(`  facilitator  ${result.facilitator ?? "not named in the challenge"}`);
  if (result.quoted) lines.push("  price        dynamic, with a signed TOLLWAY-QUOTE");
  for (const [index, option] of result.accepts.entries()) {
    lines.push(`  option ${index + 1}`);
    lines.push(`    price      ${option.amount} (asset base units)`);
    lines.push(`    asset      ${option.asset}`);
    lines.push(`    payee      ${option.payTo}`);
    lines.push(`    network    ${option.network}`);
    lines.push(`    scheme     ${option.scheme}, valid ${option.maxTimeoutSeconds} s`);
  }
  print(io, flags.json, result, lines);
  return EXIT_OK;
}

/** Runs one invocation and returns its exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        json: { type: "boolean" };
        raw: { type: "boolean" };
        help: { type: "boolean"; short: "h" };
        keys: { type: "string" };
        jwks: { type: "string" };
        method: { type: "string" };
        header: { type: "string"; multiple: true };
        timeout: { type: "string" };
      };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: "boolean" },
        raw: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        keys: { type: "string" },
        jwks: { type: "string" },
        method: { type: "string" },
        header: { type: "string", multiple: true },
        timeout: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.stderr(`tollway: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    (command === undefined && !values.help ? io.stderr : io.stdout)(USAGE);
    return command === undefined && !values.help ? EXIT_USAGE : EXIT_OK;
  }
  const json = values.json ?? false;
  try {
    switch (command) {
      case "decode":
        return await decodeCommand(rest, { json, raw: values.raw ?? false }, io);
      case "verify":
        return await verifyCommand(
          rest,
          {
            json,
            ...(values.keys === undefined ? {} : { keys: values.keys }),
            ...(values.jwks === undefined ? {} : { jwks: values.jwks }),
          },
          io,
        );
      case "inspect":
        return await inspectCommand(
          rest,
          {
            json,
            header: values.header ?? [],
            ...(values.method === undefined ? {} : { method: values.method }),
            ...(values.timeout === undefined ? {} : { timeout: values.timeout }),
          },
          io,
        );
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      io.stderr(`tollway: ${message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (json) io.stderr(`${JSON.stringify({ error: message })}\n`);
    else io.stderr(`tollway ${command}: ${message}\n`);
    // Bad input, an unreachable URL and a failed verification are all
    // failures of the thing being checked, not of the command line.
    return EXIT_FAILURE;
  }
}
