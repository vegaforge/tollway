import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Keypair } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { isPaymentPayloadV2, isPaymentRequirementsV2 } from "@x402/core/schemas";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { errorMessage, listen, readBody } from "./tls-proxy.js";

/**
 * A test-only x402 facilitator: `@x402/core`'s `x402Facilitator` with the
 * `@x402/stellar` exact scheme, pointed at the local RPC and served over
 * HTTP so `createHttpFacilitator` reaches it through real `/verify`,
 * `/settle` and `/supported` calls.
 *
 * It lives under tests/ and is never exported from a package: Tollway calls
 * a facilitator, it never is one (docs/design.md, "What Tollway is not").
 */
export type TestFacilitator = {
  url: string;
  /** How many times each endpoint was called, to prove a duplicate never reached /settle. */
  calls: { verify: number; settle: number; supported: number };
  close(): Promise<void>;
};

export async function startTestFacilitator(options: {
  rpcUrl: string;
  /** Pays the network fee and submits the settlement transaction. */
  feePayer: Keypair;
}): Promise<TestFacilitator> {
  const scheme = new ExactStellarScheme(
    [createEd25519Signer(options.feePayer.secret(), STELLAR_TESTNET_CAIP2)],
    { rpcConfig: { url: options.rpcUrl } },
  );
  const facilitator = new x402Facilitator().register(STELLAR_TESTNET_CAIP2, scheme);
  const calls = { verify: 0, settle: 0, supported: 0 };

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      send(response, 500, { error: errorMessage(error) });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? "";
    if (request.method === "GET" && path === "/supported") {
      calls.supported += 1;
      send(response, 200, facilitator.getSupported());
      return;
    }
    if (request.method === "POST" && (path === "/verify" || path === "/settle")) {
      const body = parseRequest(await readBody(request));
      if ("error" in body) {
        send(response, 400, body);
        return;
      }
      if (path === "/verify") {
        calls.verify += 1;
        send(response, 200, await facilitator.verify(body.payload, body.requirements));
      } else {
        calls.settle += 1;
        send(response, 200, await facilitator.settle(body.payload, body.requirements));
      }
      return;
    }
    send(response, 404, { error: `no route for ${request.method} ${path}` });
  }

  const listening = await listen(server, "http");
  return { ...listening, calls };
}

type ParsedRequest =
  | {
      payload: Parameters<x402Facilitator["verify"]>[0];
      requirements: Parameters<x402Facilitator["verify"]>[1];
    }
  | { error: string };

/** The body `HTTPFacilitatorClient` sends, checked with `@x402/core`'s own schemas. */
function parseRequest(raw: Buffer): ParsedRequest {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return { error: `request body is not JSON: ${errorMessage(error)}` };
  }
  if (typeof body !== "object" || body === null) {
    return { error: "request body is not an object" };
  }
  const { paymentPayload, paymentRequirements } = body as Record<string, unknown>;
  if (!isPaymentPayloadV2(paymentPayload)) {
    return { error: "paymentPayload is not an x402 V2 payment payload" };
  }
  if (!isPaymentRequirementsV2(paymentRequirements)) {
    return { error: "paymentRequirements are not x402 V2 payment requirements" };
  }
  const accepted = toRequirements(paymentPayload.accepted);
  const requirements = toRequirements(paymentRequirements);
  if (typeof accepted === "string") return { error: `paymentPayload.accepted: ${accepted}` };
  if (typeof requirements === "string") return { error: `paymentRequirements: ${requirements}` };
  // The schema allows `extensions: null`; the facilitator's type does not,
  // and null and absent mean the same thing on the wire.
  const { extensions, ...rest } = paymentPayload;
  const payload = extensions ? { ...rest, accepted, extensions } : { ...rest, accepted };
  return { payload, requirements };
}

type Requirements = Parameters<x402Facilitator["verify"]>[1];

/**
 * Narrows schema-checked V2 requirements to the type `x402Facilitator`
 * takes. The V2 schema allows any network string and an absent `extra`;
 * the facilitator wants a CAIP-2 id and an object. Returns the reason when
 * they do not fit.
 */
function toRequirements(
  value: Omit<Requirements, "network" | "extra"> & {
    network: string;
    extra?: Record<string, unknown> | null;
  },
): Requirements | string {
  const { network, extra } = value;
  if (!isCaip2(network)) return `network "${network}" is not a CAIP-2 id`;
  if (!extra) return "extra is missing";
  return { ...value, network, extra };
}

function isCaip2(value: string): value is `${string}:${string}` {
  return /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(value);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
