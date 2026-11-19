import {
  buildReceipt,
  Ed25519Signer,
  type PaymentOffer,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import { encodeHeader } from "@vegaforge/tollway-server";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";

/**
 * Header fixtures built with the encoders the packages ship: x402's own
 * helpers for the x402 shapes and the server's `encodeHeader` for the
 * Tollway shapes, so the tests decode exactly what goes over the wire.
 */

export const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const PAYER = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
export const PAYEE = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

/**
 * A testnet transaction calling `transfer(PAYER, PAYEE, 10000)` on the USDC
 * contract, built once with @stellar/stellar-base 15 from fixed seeds (bytes
 * of 1 and 2). It is a constant because key generation inside jsdom fails
 * on cross-realm Uint8Arrays.
 */
export const TRANSFER_XDR =
  "AAAAAgAAAACKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXAAAAGQAAAAAAAAAKgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwEAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1wAAAASAAAAAAAAAACBOXcOqH0XX1ajVGbDTH7My42KkbTuN6Jd9g9bj8mzlAAAAAoAAAAAAAAAAAAAAAAAACcQAAAAAAAAAAAAAAAA";

export const paymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: { url: "https://api.example.test/quote", description: "A quote" },
  accepts: [
    {
      scheme: "exact",
      network: "stellar:testnet",
      amount: "10000",
      asset: USDC_TESTNET,
      payTo: PAYEE,
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
};

export const paymentPayload: PaymentPayload = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "10000",
    asset: USDC_TESTNET,
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    extra: {},
  },
  payload: { transaction: TRANSFER_XDR },
};

export const settleResponse: SettleResponse = {
  success: true,
  payer: PAYER,
  transaction: "a".repeat(64),
  network: "stellar:testnet",
};

export const offer: PaymentOffer = {
  resource: "https://api.example.test/quote",
  amount: "10000",
  asset: USDC_TESTNET,
  payTo: PAYEE,
  network: "testnet",
  models: ["x402", "mpp-charge"],
};

export const headers = {
  x402Required: encodePaymentRequiredHeader(paymentRequired),
  x402Signature: encodePaymentSignatureHeader(paymentPayload),
  x402Response: encodePaymentResponseHeader(settleResponse),
  tollwayOffer: encodeHeader(offer),
};

export async function signedReceipt(
  keyId = "playground-test-key",
): Promise<{ receipt: SignedReceipt; header: string; signer: Ed25519Signer }> {
  const signer = await Ed25519Signer.generate(keyId);
  const receipt = await signReceipt(
    buildReceipt({
      payer: PAYER,
      payee: PAYEE,
      amount: "10000",
      asset: USDC_TESTNET,
      resource: "https://api.example.test/quote",
      model: "x402",
      settlement: { kind: "transaction", txHash: "a".repeat(64) },
      network: "testnet",
    }),
    signer,
  );
  return { receipt, header: encodeHeader(receipt), signer };
}
