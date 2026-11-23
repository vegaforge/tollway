import { describe, expect, it } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhook-signature.js";

const SECRET = "whsec_test_secret";
const NOW = 1_800_000_000_000;

describe("signWebhookPayload", () => {
  it("emits a t=,v1= header over the exact body", async () => {
    const header = await signWebhookPayload({ secret: SECRET, payload: '{"a":1}', now: NOW });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${Math.floor(NOW / 1000)},`)).toBe(true);
  });

  it("changes with the body, the secret and the timestamp", async () => {
    const base = await signWebhookPayload({ secret: SECRET, payload: "one", now: NOW });
    expect(await signWebhookPayload({ secret: SECRET, payload: "two", now: NOW })).not.toBe(base);
    expect(await signWebhookPayload({ secret: "other", payload: "one", now: NOW })).not.toBe(base);
    expect(await signWebhookPayload({ secret: SECRET, payload: "one", now: NOW + 1000 })).not.toBe(
      base,
    );
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a signature it produced", async () => {
    const payload = '{"type":"receipt.created"}';
    const header = await signWebhookPayload({ secret: SECRET, payload, now: NOW });

    await expect(
      verifyWebhookSignature({ payload, header, secret: SECRET, now: NOW }),
    ).resolves.toEqual({ valid: true });
  });

  it("rejects a forged body", async () => {
    const header = await signWebhookPayload({
      secret: SECRET,
      payload: '{"amount":"1"}',
      now: NOW,
    });

    await expect(
      verifyWebhookSignature({
        payload: '{"amount":"1000000"}',
        header,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("rejects a forged signature", async () => {
    const payload = "{}";
    const header = `t=${Math.floor(NOW / 1000)},v1=${"0".repeat(64)}`;

    await expect(
      verifyWebhookSignature({ payload, header, secret: SECRET, now: NOW }),
    ).resolves.toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("rejects a replayed delivery outside the tolerance", async () => {
    const payload = "{}";
    const header = await signWebhookPayload({ secret: SECRET, payload, now: NOW });

    await expect(
      verifyWebhookSignature({
        payload,
        header,
        secret: SECRET,
        now: NOW + 301_000,
      }),
    ).resolves.toEqual({ valid: false, reason: "timestamp-out-of-tolerance" });
  });

  it("accepts a timestamp exactly on the tolerance edge", async () => {
    const payload = "{}";
    const header = await signWebhookPayload({ secret: SECRET, payload, now: NOW });

    await expect(
      verifyWebhookSignature({
        payload,
        header,
        secret: SECRET,
        now: NOW + 300_000,
        toleranceSeconds: 300,
      }),
    ).resolves.toEqual({ valid: true });
  });

  it("honours a custom tolerance", async () => {
    const payload = "{}";
    const header = await signWebhookPayload({ secret: SECRET, payload, now: NOW });

    await expect(
      verifyWebhookSignature({
        payload,
        header,
        secret: SECRET,
        now: NOW + 10_000,
        toleranceSeconds: 5,
      }),
    ).resolves.toEqual({ valid: false, reason: "timestamp-out-of-tolerance" });
  });

  it("rejects a malformed header", async () => {
    for (const header of ["", "t=1", "v1=abcd", "t=abc,v1=00", "t=1,v1=ABCD", `${SECRET}`]) {
      await expect(
        verifyWebhookSignature({ payload: "{}", header, secret: SECRET, now: NOW }),
      ).resolves.toEqual({ valid: false, reason: "malformed-header" });
    }
  });

  it("rejects a negative or fractional tolerance", async () => {
    const header = await signWebhookPayload({ secret: SECRET, payload: "{}", now: NOW });
    await expect(
      verifyWebhookSignature({ payload: "{}", header, secret: SECRET, toleranceSeconds: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      verifyWebhookSignature({ payload: "{}", header, secret: SECRET, toleranceSeconds: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("names the failure reason without leaking the secret", async () => {
    const result = await verifyWebhookSignature({
      payload: "{}",
      header: "nonsense",
      secret: SECRET,
      now: NOW,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("Tollway-Signature");
  });
});
