/** Shared by the #164 adapter tests: a gate that binds the body, and a facilitator that counts calls. */
import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  type FacilitatorClient,
  type Gate,
  type PaywallConfig,
} from "@vegaforge/tollway-server";

export const BOUND_CONFIG = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
  resource: "/infer",
  bindBody: { maxBytes: 1024 },
} satisfies PaywallConfig;

export async function boundGate(): Promise<{ gate: Gate; calls: () => number }> {
  const inner = createMockFacilitator();
  let calls = 0;
  const facilitator: FacilitatorClient = {
    ...inner,
    async verify(input) {
      calls++;
      return inner.verify(input);
    },
    async settle(input) {
      calls++;
      return inner.settle(input);
    },
  };
  const gate = createPaywall(BOUND_CONFIG, {
    signer: await Ed25519Signer.generate("adapter-body"),
    facilitator,
    cache: createInMemorySettlementCache(),
  });
  return { gate, calls: () => calls };
}

/** Pays a 402 the way a stock x402 V2 client does. */
export function payFrom(paymentRequired: string | null | undefined): string {
  const accepted = decodePaymentRequiredHeader(paymentRequired ?? "").accepts[0];
  if (!accepted) throw new Error("the 402 offers no payment requirements");
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { transaction: "signed-for-prompt-a" },
  });
}

export function decodeReceiptResource(header: string | null | undefined): string {
  const json = Buffer.from(header ?? "", "base64url").toString("utf8");
  return (JSON.parse(json) as { receipt: { resource: string } }).receipt.resource;
}

/** A body sent as several chunks, so the server sees Transfer-Encoding: chunked. */
export function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

export const PROMPT_A = '{"prompt":"summarise this sentence"}';
export const PROMPT_B = '{"prompt":"write a whole novel, please"}';
