import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Account,
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  buildReceipt,
  bytesToBase64Url,
  Ed25519Signer,
  type SignedReceipt,
  signReceipt,
  utf8Bytes,
} from "@vegaforge/tollway-core";
import {
  createMockFacilitator,
  createPaywall,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER as SERVER_PAYMENT_REQUIRED_HEADER,
  TOLLWAY_QUOTE_HEADER as SERVER_TOLLWAY_QUOTE_HEADER,
} from "@vegaforge/tollway-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeValue, detectEncoding } from "./decode.js";
import { PAYMENT_REQUIRED_HEADER, TOLLWAY_QUOTE_HEADER } from "./inspect.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io, run } from "./run.js";

const PAYEE = Keypair.random().publicKey();
const PAYER = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function base64(text: string): string {
  return btoa(text);
}

/** Runs the command with in-memory streams and returns what it wrote. */
async function tollway(
  argv: string[],
  overrides: Partial<Io> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => "",
    readFile: async () => {
      throw new Error("no file");
    },
    fetch: globalThis.fetch,
    ...overrides,
  });
  return { code, stdout, stderr };
}

let signer: Ed25519Signer;
let receipt: SignedReceipt;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("k1");
  receipt = await signReceipt(
    buildReceipt({
      payer: PAYER,
      payee: PAYEE,
      amount: "10000",
      asset: USDC,
      resource: "/quotes/latest",
      model: "x402",
      settlement: { kind: "transaction", txHash: "abc123" },
      network: "testnet",
    }),
    signer,
  );
});

const REQUIREMENTS = {
  scheme: "exact",
  network: "stellar:testnet" as const,
  asset: USDC,
  amount: "10000",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {},
};

function transferEnvelope(): string {
  const source = new Account(Keypair.random().publicKey(), "0");
  return new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.invokeContractFunction({
        contract: USDC,
        function: "transfer",
        args: [
          new Address(PAYER).toScVal(),
          new Address(PAYEE).toScVal(),
          nativeToScVal(10000n, { type: "i128" }),
        ],
      }),
    )
    .setTimeout(60)
    .build()
    .toXDR();
}

describe("tollway decode", () => {
  it("decodes a PAYMENT-REQUIRED value (standard base64)", async () => {
    const value = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: "/quotes/latest" },
      accepts: [REQUIREMENTS],
    });
    const { code, stdout } = await tollway(["decode", value, "--json"]);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(stdout)).toMatchObject({
      encoding: "base64",
      shape: "x402-payment-required",
      value: { accepts: [{ amount: "10000", payTo: PAYEE }] },
    });
  });

  it("decodes a TOLLWAY-RECEIPT value (base64url) and accepts a copied header line", async () => {
    const value = bytesToBase64Url(utf8Bytes(JSON.stringify(receipt)));
    const { code, stdout } = await tollway(["decode", `TOLLWAY-RECEIPT: ${value}`]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("Tollway SignedReceipt");
    expect(decodeValue(value).shape).toBe("tollway-signed-receipt");
  });

  it("decodes a PAYMENT-RESPONSE value as a SettleResponse", async () => {
    const value = encodePaymentResponseHeader({
      success: true,
      transaction: "abc123",
      network: "stellar:testnet",
      payer: PAYER,
    });
    expect(decodeValue(value)).toMatchObject({ shape: "x402-settle-response" });
  });

  it("summarises a PAYMENT-SIGNATURE and hides its envelope unless --raw", async () => {
    const envelope = transferEnvelope();
    const value = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: { url: "/quotes/latest" },
      accepted: REQUIREMENTS,
      payload: { transaction: envelope },
    });
    const summary = await tollway(["decode", value, "--json"]);
    expect(summary.code).toBe(EXIT_OK);
    expect(JSON.parse(summary.stdout)).toMatchObject({
      shape: "x402-payment-payload",
      summary: { network: "stellar:testnet", amount: "10000", payTo: PAYEE, payer: PAYER },
    });
    expect(summary.stdout).not.toContain(envelope);

    const raw = await tollway(["decode", value, "--raw"]);
    expect(raw.stdout).toContain(envelope);
  });

  it("reads the value from stdin with -", async () => {
    const value = bytesToBase64Url(utf8Bytes(JSON.stringify(receipt)));
    const { code } = await tollway(["decode", "-"], { readStdin: async () => `${value}\n` });
    expect(code).toBe(EXIT_OK);
  });

  it.each([
    ["malformed base64", "not*base64!"],
    ["mixed alphabets", "ab+c-d"],
    ["valid base64 with invalid JSON", base64("{not json")],
    ["valid JSON with the wrong shape", base64(JSON.stringify({ hello: "world" }))],
  ])("fails with exit 1 on %s", async (_name, value) => {
    const { code, stderr, stdout } = await tollway(["decode", value]);
    expect(code).toBe(EXIT_FAILURE);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^tollway decode: /);
  });

  it("reports an unrecognised value as JSON on stderr with --json", async () => {
    const { code, stderr } = await tollway(["decode", base64("[]"), "--json"]);
    expect(code).toBe(EXIT_FAILURE);
    expect(JSON.parse(stderr)).toHaveProperty("error");
  });

  it("names the alphabet it found", () => {
    expect(detectEncoding("ab-_")).toBe("base64url");
    expect(detectEncoding("ab+/")).toBe("base64");
  });
});

describe("tollway verify", () => {
  function files(map: Record<string, string>): Pick<Io, "readFile"> {
    return {
      readFile: async (path) => {
        const content = map[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
    };
  }

  it("verifies a receipt against a key-set document", async () => {
    const keySet = JSON.stringify({
      keys: [{ ...signer.publicJwk(), status: { state: "active" } }],
    });
    const { code, stdout } = await tollway(["verify", "r.json", "--keys", "keys.json"], {
      ...files({ "r.json": JSON.stringify(receipt), "keys.json": keySet }),
    });
    expect(code).toBe(EXIT_OK);
    expect(stdout).toBe("valid: signed by k1\n");
  });

  it("verifies an encoded TOLLWAY-RECEIPT against a key map, from stdin", async () => {
    const keys = JSON.stringify({ k1: bytesToBase64Url(signer.publicKey) });
    const { code } = await tollway(["verify", "-", "--keys", "keys.json"], {
      readStdin: async () => bytesToBase64Url(utf8Bytes(JSON.stringify(receipt))),
      ...files({ "keys.json": keys }),
    });
    expect(code).toBe(EXIT_OK);
  });

  it("prints the reason and exits 1 for a tampered receipt", async () => {
    const tampered = { ...receipt, receipt: { ...receipt.receipt, amount: "1" } };
    const keys = JSON.stringify({ k1: bytesToBase64Url(signer.publicKey) });
    const { code, stdout } = await tollway(["verify", "r.json", "--keys", "keys.json", "--json"], {
      ...files({ "r.json": JSON.stringify(tampered), "keys.json": keys }),
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(JSON.parse(stdout)).toMatchObject({ valid: false, keyId: "k1" });
  });

  it("fetches keys from --jwks", async () => {
    const keySet = JSON.stringify({
      keys: [{ ...signer.publicJwk(), status: { state: "active" } }],
    });
    const fetched: string[] = [];
    const { code } = await tollway(["verify", "r.json", "--jwks", "https://svc.test/keys"], {
      ...files({ "r.json": JSON.stringify(receipt) }),
      keySetFetch: async (url) => {
        fetched.push(url);
        return { status: 200, headers: new Headers(), text: async () => keySet };
      },
    });
    expect(code).toBe(EXIT_OK);
    expect(fetched).toEqual(["https://svc.test/keys"]);
  });

  it("is a usage error without exactly one key source", async () => {
    expect((await tollway(["verify", "r.json"])).code).toBe(EXIT_USAGE);
    expect(
      (await tollway(["verify", "r.json", "--keys", "a", "--jwks", "https://x.test"])).code,
    ).toBe(EXIT_USAGE);
  });
});

describe("tollway inspect", () => {
  let server: Server;
  let base: string;
  let hops = 0;

  beforeAll(async () => {
    const gate = createPaywall(
      { amount: "10000", asset: USDC, payTo: PAYEE, network: "testnet" },
      { signer, facilitator: createMockFacilitator() },
    );
    server = createServer(async (req, res) => {
      if (req.url === "/moved") {
        hops++;
        res.writeHead(302, { location: "/quotes/latest" }).end();
        return;
      }
      if (req.url === "/away") {
        res.writeHead(302, { location: "https://elsewhere.test/quotes" }).end();
        return;
      }
      if (req.url === "/free") {
        res.writeHead(200).end("free");
        return;
      }
      const outcome = await gate({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
      });
      res.writeHead(outcome.status, outcome.headers).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("explains the 402 a local gate returns", async () => {
    const { code, stdout } = await tollway(["inspect", `${base}/quotes/latest`, "--json"]);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(stdout)).toMatchObject({
      paid: true,
      status: 402,
      resource: "/quotes/latest",
      models: ["x402"],
      accepts: [{ amount: "10000", asset: USDC, payTo: PAYEE, network: "stellar:testnet" }],
    });
    const text = await tollway(["inspect", `${base}/quotes/latest`]);
    expect(text.stdout).toContain(`payee      ${PAYEE}`);
  });

  it("follows a same-origin redirect", async () => {
    const { code } = await tollway(["inspect", `${base}/moved`]);
    expect(code).toBe(EXIT_OK);
    expect(hops).toBe(1);
  });

  it("refuses to follow a redirect to another origin", async () => {
    const { code, stderr } = await tollway(["inspect", `${base}/away`]);
    expect(code).toBe(EXIT_FAILURE);
    expect(stderr).toContain("another origin");
  });

  it("exits 1 when the URL does not ask for payment", async () => {
    const { code, stdout } = await tollway(["inspect", `${base}/free`]);
    expect(code).toBe(EXIT_FAILURE);
    expect(stdout).toContain("answered 200, not 402");
  });

  it("gives up after --timeout", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { code, stderr } = await tollway(["inspect", `${base}/slow`, "--timeout", "20"], {
      fetch: hanging,
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(stderr).toContain("within 20 ms");
  });

  it("is a usage error for a bad --header or --timeout", async () => {
    expect((await tollway(["inspect", base, "--header", "nocolon"])).code).toBe(EXIT_USAGE);
    expect((await tollway(["inspect", base, "--timeout", "-1"])).code).toBe(EXIT_USAGE);
  });
});

describe("header names", () => {
  it("match the gate's", () => {
    expect(PAYMENT_REQUIRED_HEADER).toBe(SERVER_PAYMENT_REQUIRED_HEADER);
    expect(TOLLWAY_QUOTE_HEADER).toBe(SERVER_TOLLWAY_QUOTE_HEADER);
  });
});

describe("usage", () => {
  it("prints help with exit 0", async () => {
    const { code, stdout } = await tollway(["--help"]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("Usage: tollway");
  });

  it("exits 2 with no command, an unknown command or an unknown flag", async () => {
    expect((await tollway([])).code).toBe(EXIT_USAGE);
    expect((await tollway(["pay"])).code).toBe(EXIT_USAGE);
    expect((await tollway(["decode", "x", "--secret-key", "S"])).code).toBe(EXIT_USAGE);
  });
});
