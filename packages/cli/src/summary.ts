import type { Decoded } from "./decode.js";

/**
 * What a PAYMENT-SIGNATURE is safe to show by default. The value carries a
 * signed transaction envelope, which can be submitted by whoever holds it,
 * so the envelope itself is only printed with `--raw`.
 */
export type PaymentSummary = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  /** The account the transfer is from, read from the envelope. */
  payer?: string;
  /** Why `payer` is missing, when it is. */
  payerUnknown?: string;
  resource?: string;
};

type PayloadShape = {
  accepted: { scheme: string; network: string; amount: string; asset: string; payTo: string };
  resource?: { url?: string };
  payload: Record<string, unknown>;
};

const PASSPHRASES: Record<string, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

/**
 * Reads the `from` of the Soroban `transfer` the envelope invokes. The SDK
 * is imported here, lazily, so decoding any other header stays fast.
 */
async function payerOf(
  transaction: string,
  network: string,
): Promise<{ payer: string } | { payerUnknown: string }> {
  const passphrase = PASSPHRASES[network];
  if (passphrase === undefined) {
    return { payerUnknown: `no Stellar passphrase is known for network ${network}` };
  }
  const sdk = await import("@stellar/stellar-sdk");
  let parsed: ReturnType<typeof sdk.TransactionBuilder.fromXDR>;
  try {
    parsed = sdk.TransactionBuilder.fromXDR(transaction, passphrase);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { payerUnknown: `the transaction envelope is not valid XDR: ${reason}` };
  }
  const inner = "innerTransaction" in parsed ? parsed.innerTransaction : parsed;
  for (const operation of inner.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    const fn = operation.func;
    if (fn.switch().name !== "hostFunctionTypeInvokeContract") continue;
    const [from] = fn.invokeContract().args();
    if (from) return { payer: String(sdk.scValToNative(from)) };
  }
  return { payerUnknown: "the envelope invokes no contract call with a from address" };
}

/** Summarises an x402 PaymentPayload without its signed envelope. */
export async function summarisePayment(decoded: Decoded): Promise<PaymentSummary> {
  const payload = decoded.value as PayloadShape;
  const { accepted } = payload;
  const transaction = payload.payload.transaction;
  const payer =
    typeof transaction === "string"
      ? await payerOf(transaction, accepted.network)
      : { payerUnknown: "the payload carries no transaction envelope" };
  return {
    scheme: accepted.scheme,
    network: accepted.network,
    amount: accepted.amount,
    asset: accepted.asset,
    payTo: accepted.payTo,
    ...payer,
    ...(payload.resource?.url === undefined ? {} : { resource: payload.resource.url }),
  };
}
