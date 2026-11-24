import { Ed25519Signer, Ed25519Verifier, verifyReceipt } from "@vegaforge/tollway-core";
import { Challenge, Credential } from "mppx";
import { describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall } from "./gate.js";
import {
  createInMemoryChannelRegistry,
  createInMemoryVoucherStore,
  createMockMppChannelHandler,
  parseMppChannelCredential,
} from "./mpp-channel.js";

const CHANNEL_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAYER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const PAYEE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function makeChannelHeader(input: {
  channelId: string;
  sequence: number;
  cumulativeAmount: string;
  commitment: string;
  action?: "voucher" | "close";
}): string {
  const challenge = Challenge.from({
    id: `chal-${input.sequence}`,
    realm: "tollway",
    method: "stellar",
    intent: "channel",
    request: { channel: input.channelId },
  });
  return Credential.serialize({
    challenge,
    payload: {
      channel: input.channelId,
      sequence: input.sequence,
      amount: input.cumulativeAmount,
      signature: input.commitment,
      ...(input.action ? { action: input.action } : {}),
    },
  });
}

describe("mpp-channel gate verification (#173)", () => {
  it("settles mpp-channel vouchers and returns canonical channel-commitment receipts", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const verifier = await Ed25519Verifier.fromPublicKey(signer.publicKey, signer.keyId);
    const registry = createInMemoryChannelRegistry([
      {
        channelId: CHANNEL_ID,
        commitmentKey: "a".repeat(64),
        payer: PAYER,
        network: "testnet",
        asset: ASSET,
        recipient: PAYEE,
      },
    ]);
    const voucherStore = createInMemoryVoucherStore({ now: () => "2026-11-24T12:00:00.000Z" });
    const mppChannelHandler = createMockMppChannelHandler({
      registry,
      voucherStore,
      readChannelState: async () => ({
        balance: "5000",
        token: ASSET,
        to: PAYEE,
        closeEffectiveAtLedger: null,
        currentLedger: 100,
      }),
    });

    const gate = createPaywall(
      {
        amount: "1000",
        asset: ASSET,
        payTo: PAYEE,
        network: "testnet",
        models: ["mpp-channel"],
      },
      {
        signer,
        facilitator: createMockFacilitator(),
        mppChannelHandler,
        cache: createInMemorySettlementCache(),
      },
    );

    const header1 = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 1,
      cumulativeAmount: "1000",
      commitment: "sig-1",
    });
    const res1 = await gate({
      method: "GET",
      url: "https://api.example/resource",
      headers: { authorization: header1 },
    });

    expect(res1.kind).toBe("settled");
    if (res1.kind === "settled") {
      expect(res1.replayed).toBe(false);
      expect(res1.receipt.receipt.model).toBe("mpp-channel");
      expect(res1.receipt.receipt.settlement).toEqual({
        kind: "channel-commitment",
        channelId: CHANNEL_ID,
        sequence: 1,
      });
      const verified = await verifyReceipt(res1.receipt, verifier);
      expect(verified.valid).toBe(true);
    }

    // Replaying the same voucher at sequence 1 returns a cached replay.
    const replay = await gate({
      method: "GET",
      url: "https://api.example/resource",
      headers: { authorization: header1 },
    });
    expect(replay.kind).toBe("settled");
    if (replay.kind === "settled") {
      expect(replay.replayed).toBe(true);
    }

    // Sequence 2 advances cumulativeAmount.
    const header2 = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 2,
      cumulativeAmount: "2000",
      commitment: "sig-2",
    });
    const res2 = await gate({
      method: "GET",
      url: "https://api.example/resource",
      headers: { authorization: header2 },
    });
    expect(res2.kind).toBe("settled");
    const latest = await voucherStore.getLatest(CHANNEL_ID);
    expect(latest?.sequence).toBe(2);
    expect(latest?.cumulativeAmount).toBe("2000");
    expect(latest?.commitment).toBe("sig-2");
  });

  it("rejects conflicting vouchers at the same sequence and non-monotonic amounts", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const voucherStore = createInMemoryVoucherStore();
    const mppChannelHandler = createMockMppChannelHandler({ voucherStore });

    const gate = createPaywall(
      {
        amount: "1000",
        asset: ASSET,
        payTo: PAYEE,
        network: "testnet",
        models: ["mpp-channel"],
      },
      { signer, facilitator: createMockFacilitator(), mppChannelHandler },
    );

    const h1 = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 1,
      cumulativeAmount: "1000",
      commitment: "sig-1",
    });
    expect((await gate({ method: "GET", url: "/x", headers: { authorization: h1 } })).kind).toBe("settled");

    // Different commitment at same sequence -> rejected.
    const conflict = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 1,
      cumulativeAmount: "1500",
      commitment: "sig-1-alt",
    });
    const conflictRes = await gate({ method: "GET", url: "/x", headers: { authorization: conflict } });
    expect(conflictRes.kind).toBe("rejected");
    if (conflictRes.kind === "rejected") {
      expect(conflictRes.status).toBe(402);
      expect(conflictRes.reason).toContain("commitment-conflict");
    }

    // Insufficient increment at sequence 2 -> rejected.
    const low = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 2,
      cumulativeAmount: "1500",
      commitment: "sig-2",
    });
    const lowRes = await gate({ method: "GET", url: "/x", headers: { authorization: low } });
    expect(lowRes.kind).toBe("rejected");
  });

  it("rejects vouchers when on-chain channel is closing or underfunded", async () => {
    const signer = await Ed25519Signer.generate("key-1");
    const mppChannelHandler = createMockMppChannelHandler({
      readChannelState: async () => ({
        balance: "5000",
        token: ASSET,
        to: PAYEE,
        closeEffectiveAtLedger: 120,
        currentLedger: 100,
      }),
    });

    const gate = createPaywall(
      {
        amount: "1000",
        asset: ASSET,
        payTo: PAYEE,
        network: "testnet",
        models: ["mpp-channel"],
      },
      { signer, facilitator: createMockFacilitator(), mppChannelHandler },
    );

    const h1 = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 1,
      cumulativeAmount: "1000",
      commitment: "sig-1",
    });
    const res = await gate({ method: "GET", url: "/x", headers: { authorization: h1 } });
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") {
      expect(res.reason).toContain("closing");
    }
  });

  it("parses mpp-channel credentials cleanly", () => {
    const header = makeChannelHeader({
      channelId: CHANNEL_ID,
      sequence: 3,
      cumulativeAmount: "3000",
      commitment: "sig-3",
      action: "close",
    });
    const parsed = parseMppChannelCredential(header);
    expect(parsed).toEqual({
      model: "mpp-channel",
      channelId: CHANNEL_ID,
      sequence: 3,
      cumulativeAmount: "3000",
      commitment: "sig-3",
      credential: header,
      action: "close",
    });
  });
});
