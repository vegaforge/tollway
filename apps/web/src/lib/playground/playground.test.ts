// @vitest-environment node
import { bytesToBase64Url, utf8Bytes } from "@vegaforge/tollway-core";
import { decodeHeader } from "@vegaforge/tollway-server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";

import {
  headers,
  offer,
  PAYEE,
  PAYER,
  paymentPayload,
  paymentRequired,
  signedReceipt,
  TRANSFER_XDR,
} from "../../test/fixtures";
import { decodeHeaderValue } from "./decode";
import { encodeChallenge } from "./encode";
import { decodeHeaderText, detectEncoding, MAX_HEADER_LENGTH } from "./encoding";
import { fromShareFragment, toShareFragment } from "./share";
import { summarizeSignature } from "./signature";
import { parseTrustedKeys, verifyPastedReceipt } from "./verify";
import { decodeStellarTransfer } from "./xdr";

function standardBase64(value: unknown): string {
  return btoa(String.fromCharCode(...utf8Bytes(JSON.stringify(value))));
}

describe("encoding detection", () => {
  it("tells base64url from base64 by alphabet and padding", () => {
    expect(detectEncoding("ab-_")).toEqual({
      ok: true,
      detected: { encoding: "base64url", certain: true },
    });
    expect(detectEncoding("ab+/")).toEqual({
      ok: true,
      detected: { encoding: "base64", certain: true },
    });
    expect(detectEncoding("abc=")).toEqual({
      ok: true,
      detected: { encoding: "base64", certain: true },
    });
    // Unpadded with a length that is not a multiple of four: only base64url omits padding.
    expect(detectEncoding("abcde")).toEqual({
      ok: true,
      detected: { encoding: "base64url", certain: true },
    });
    expect(detectEncoding("abcd")).toEqual({
      ok: true,
      detected: { encoding: "base64", certain: false },
    });
    expect(detectEncoding('{"a":1}')).toEqual({
      ok: true,
      detected: { encoding: "json", certain: true },
    });
  });

  it("rejects mixed alphabets and foreign characters", () => {
    expect(detectEncoding("ab+_")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/mixes/),
    });
    expect(detectEncoding("ab cd")).toMatchObject({ ok: false });
    expect(detectEncoding("ab*d")).toMatchObject({ ok: false });
  });

  it("rejects empty, oversize, non-UTF-8 and non-JSON input", () => {
    expect(decodeHeaderText("   ")).toMatchObject({
      ok: false,
      error: "Paste a header value first.",
    });
    const oversize = decodeHeaderText("a".repeat(MAX_HEADER_LENGTH + 1));
    expect(oversize).toMatchObject({ ok: false, error: expect.stringMatching(/limited to 16384/) });
    expect(decodeHeaderText("_w")).toMatchObject({
      ok: false,
      error: "The decoded bytes are not UTF-8 text.",
    });
    expect(decodeHeaderText(bytesToBase64Url(utf8Bytes("not json")))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not JSON/),
    });
    expect(decodeHeaderText("a")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not valid base64url/),
    });
  });
});

describe("decoding and shape identification", () => {
  it("decodes an x402 PaymentRequired written by encodePaymentRequiredHeader", () => {
    const result = decodeHeaderValue("PAYMENT-REQUIRED", headers.x402Required);
    expect(result).toMatchObject({
      ok: true,
      shape: "x402-payment-required",
      valid: true,
      errors: [],
    });
    if (!result.ok) throw new Error("expected a decode");
    expect(result.detected.encoding).toBe("base64");
    expect(result.fields).toContainEqual({
      path: "accepts[0].amount",
      value: "10000",
      explanation: expect.stringMatching(/integer string/),
    });
  });

  it("decodes a Tollway offer written by the server's encodeHeader and labels it base64url", () => {
    const result = decodeHeaderValue("PAYMENT-REQUIRED", headers.tollwayOffer);
    expect(result).toMatchObject({
      ok: true,
      shape: "tollway-offer",
      valid: true,
      detected: { encoding: "base64url" },
      value: offer,
    });
  });

  it("points out an x402 shape in base64url and a Tollway shape in base64", () => {
    // Both fixtures are padded or unpadded in a way that settles the encoding.
    const x402InUrl = decodeHeaderValue(
      "PAYMENT-REQUIRED",
      bytesToBase64Url(utf8Bytes(JSON.stringify(paymentRequired))),
    );
    expect(x402InUrl).toMatchObject({
      ok: true,
      valid: true,
      detected: { encoding: "base64url", certain: true },
      notes: [expect.stringMatching(/x402 shape in base64url/)],
    });
    const tollwayInStandard = decodeHeaderValue("PAYMENT-REQUIRED", standardBase64(offer));
    expect(tollwayInStandard).toMatchObject({
      ok: true,
      shape: "tollway-offer",
      valid: true,
      detected: { encoding: "base64", certain: true },
      notes: [expect.stringMatching(/Tollway shape in standard base64/)],
    });
    expect(decodeHeaderValue("PAYMENT-REQUIRED", headers.x402Required)).toMatchObject({
      notes: [],
    });
    const forced = decodeHeaderValue(
      "PAYMENT-REQUIRED",
      `${bytesToBase64Url(utf8Bytes(JSON.stringify(paymentRequired)))}-`,
    );
    expect(forced.ok).toBe(false);
  });

  it("decodes a PAYMENT-SIGNATURE and a PAYMENT-RESPONSE in both shapes", async () => {
    expect(decodeHeaderValue("PAYMENT-SIGNATURE", headers.x402Signature)).toMatchObject({
      ok: true,
      shape: "x402-payment-payload",
      valid: true,
    });
    expect(decodeHeaderValue("PAYMENT-RESPONSE", headers.x402Response)).toMatchObject({
      ok: true,
      shape: "x402-settle-response",
      valid: true,
    });
    const { header } = await signedReceipt();
    expect(decodeHeaderValue("PAYMENT-RESPONSE", header)).toMatchObject({
      ok: true,
      shape: "tollway-receipt",
      valid: true,
    });
    expect(decodeHeaderValue("TOLLWAY-RECEIPT", header)).toMatchObject({ ok: true, valid: true });
  });

  it("reports schema errors for a wrong shape, choosing the shape the value resembles", async () => {
    const badOffer = decodeHeaderValue(
      "PAYMENT-REQUIRED",
      JSON.stringify({ ...offer, amount: "0.5" }),
    );
    expect(badOffer).toMatchObject({ ok: true, shape: "tollway-offer", valid: false });
    if (!badOffer.ok) throw new Error("expected a decode");
    expect(badOffer.errors).toContain("amount: amount must be an integer string");

    const v2WithoutAccepts = decodeHeaderValue(
      "PAYMENT-REQUIRED",
      JSON.stringify({ x402Version: 2, resource: { url: "x" }, accepts: [] }),
    );
    expect(v2WithoutAccepts).toMatchObject({
      ok: true,
      shape: "x402-payment-required",
      valid: false,
    });

    const { receipt } = await signedReceipt();
    const tampered = { ...receipt, receipt: { ...receipt.receipt, extra: "field" } };
    const result = decodeHeaderValue("TOLLWAY-RECEIPT", JSON.stringify(tampered));
    expect(result).toMatchObject({ ok: true, valid: false });

    const receiptAsChallenge = decodeHeaderValue("PAYMENT-REQUIRED", JSON.stringify(receipt));
    expect(receiptAsChallenge).toMatchObject({ ok: true, valid: false });
  });

  it("flags fields a shape does not define", () => {
    const result = decodeHeaderValue(
      "PAYMENT-REQUIRED",
      JSON.stringify({ ...offer, payto: "typo" }),
    );
    if (!result.ok) throw new Error("expected a decode");
    expect(result.valid).toBe(false);
    expect(result.fields).toContainEqual({
      path: "payto",
      value: "typo",
      explanation: "Not a field of this shape.",
    });
  });
});

describe("signed payment summary and XDR", () => {
  it("summarises network and amount from the envelope", () => {
    expect(summarizeSignature(paymentPayload)).toEqual({
      network: "stellar:testnet",
      amount: "10000",
      asset: paymentPayload.accepted.asset,
      payTo: PAYEE,
      transaction: TRANSFER_XDR,
    });
    expect(summarizeSignature({ x402Version: 1 })).toBeNull();
  });

  it("reads payer, payee and an integer amount from the Soroban transfer", async () => {
    const transfer = await decodeStellarTransfer(TRANSFER_XDR, "stellar:testnet");
    expect(transfer).toMatchObject({
      payer: PAYER,
      payee: PAYEE,
      amount: "10000",
      source: PAYER,
      fee: "100",
    });
  });

  it("refuses an unknown network instead of guessing a passphrase", async () => {
    await expect(decodeStellarTransfer(TRANSFER_XDR, "eip155:1")).rejects.toThrow(
      /Unknown Stellar network/,
    );
  });
});

describe("receipt verification", () => {
  it("verifies against a bare key, a JWKS document and a { keyId, publicKey } object", async () => {
    const { receipt, signer } = await signedReceipt();
    const key = bytesToBase64Url(signer.publicKey);
    const keyId = signer.keyId;
    for (const input of [
      key,
      JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid: keyId, x: key }] }),
      JSON.stringify({ keyId, publicKey: key }),
      JSON.stringify({ [keyId]: key }),
    ]) {
      expect(await verifyPastedReceipt(receipt, input, keyId)).toMatchObject({ valid: true });
    }
  });

  it("rejects the wrong key, a short key, an unknown keyId and a tampered receipt", async () => {
    const { receipt, signer } = await signedReceipt();
    const other = await signedReceipt();
    const keyId = signer.keyId;
    expect(
      await verifyPastedReceipt(receipt, bytesToBase64Url(other.signer.publicKey), keyId),
    ).toMatchObject({
      valid: false,
    });
    expect(parseTrustedKeys(bytesToBase64Url(new Uint8Array(16)), keyId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/16 bytes/),
    });
    expect(
      await verifyPastedReceipt(
        receipt,
        JSON.stringify({ keyId: "other", publicKey: bytesToBase64Url(signer.publicKey) }),
        keyId,
      ),
    ).toMatchObject({ valid: false, reason: expect.stringMatching(/keyId/) });
    const tampered = { ...receipt, receipt: { ...receipt.receipt, amount: "1" } };
    expect(
      await verifyPastedReceipt(tampered, bytesToBase64Url(signer.publicKey), keyId),
    ).toMatchObject({
      valid: false,
    });
    expect(parseTrustedKeys("{not json", keyId)).toMatchObject({ ok: false });
    expect(parseTrustedKeys("", keyId)).toMatchObject({ ok: false });
  });
});

describe("challenge encoding", () => {
  const input = {
    resource: offer.resource,
    amount: "10000",
    asset: offer.asset,
    payTo: PAYEE,
    network: "testnet",
    models: ["x402", "mpp-charge"],
  };

  it("writes both encodings, each readable by its own decoder", () => {
    const result = encodeChallenge(input);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(decodePaymentRequiredHeader(result.encoded.x402Base64)).toMatchObject({
      x402Version: 2,
      accepts: [{ network: "stellar:testnet", amount: "10000", payTo: PAYEE }],
    });
    expect(decodeHeader(result.encoded.tollwayBase64Url)).toEqual(offer);
    expect(decodeHeaderValue("PAYMENT-REQUIRED", result.encoded.tollwayBase64Url)).toMatchObject({
      valid: true,
    });
  });

  it("maps mainnet to stellar:pubnet", () => {
    const result = encodeChallenge({ ...input, network: "mainnet" });
    if (!result.ok) throw new Error("expected a challenge");
    expect(decodePaymentRequiredHeader(result.encoded.x402Base64)).toMatchObject({
      accepts: [{ network: "stellar:pubnet" }],
    });
  });

  it.each(["1.5", "-1", "1e3", "", " ", "10 000", "0x10"])("rejects the amount %j", (amount) => {
    const result = encodeChallenge({ ...input, amount });
    expect(result).toMatchObject({
      ok: false,
      errors: { amount: expect.stringMatching(/integer string/) },
    });
  });

  it("reports every missing field at once", () => {
    expect(
      encodeChallenge({
        resource: "",
        amount: "1",
        asset: "",
        payTo: "",
        network: "devnet",
        models: [],
      }),
    ).toEqual({
      ok: false,
      errors: {
        resource: expect.any(String),
        asset: expect.any(String),
        payTo: expect.any(String),
        network: expect.any(String),
        models: expect.any(String),
      },
    });
  });
});

describe("share links", () => {
  it("round-trips decode and encode state through the fragment only", () => {
    const decode = {
      tab: "decode",
      header: "PAYMENT-REQUIRED",
      value: headers.x402Required,
    } as const;
    const link = toShareFragment(decode);
    if (!link.ok) throw new Error(link.reason);
    expect(link.fragment.startsWith("#playground=")).toBe(true);
    expect(fromShareFragment(link.fragment)).toEqual({ kind: "restored", state: decode });
  });

  it("never puts a signed payment in a link", () => {
    expect(
      toShareFragment({ tab: "decode", header: "PAYMENT-SIGNATURE", value: headers.x402Signature }),
    ).toMatchObject({
      ok: false,
    });
    const forged = `#playground=${bytesToBase64Url(
      utf8Bytes(
        JSON.stringify({
          tab: "decode",
          header: "PAYMENT-SIGNATURE",
          value: headers.x402Signature,
        }),
      ),
    )}`;
    expect(fromShareFragment(forged)).toMatchObject({ kind: "invalid" });
  });

  it("ignores other fragments and reports a broken playground fragment", () => {
    expect(fromShareFragment("#installation")).toEqual({ kind: "none" });
    expect(fromShareFragment("")).toEqual({ kind: "none" });
    expect(fromShareFragment("#playground=%%%")).toMatchObject({ kind: "invalid" });
    expect(
      fromShareFragment(`#playground=${bytesToBase64Url(utf8Bytes('{"tab":"other"}'))}`),
    ).toMatchObject({
      kind: "invalid",
    });
  });
});
