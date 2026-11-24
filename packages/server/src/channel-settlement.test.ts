import { describe, expect, it, vi } from "vitest";
import {
  createChannelSettlementScheduler,
  createInMemoryChannelSettlementStore,
  createStellarChannelSettler,
  decodeCommitmentSignature,
  isAmbiguousCloseError,
} from "./channel-settlement.js";
import { createInMemoryVoucherStore } from "./mpp-channel.js";

const CHANNEL_1 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CHANNEL_2 = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ENVELOPE_SIGNER = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SIG_HEX = "ab".repeat(64);
const TX_HASH = "f".repeat(64);

describe("on-chain channel settlement and scheduler (#174)", () => {
  it("closes a channel with maxFeeBumpStroops, derives remainder, and records settled marker", async () => {
    const settlementStore = createInMemoryChannelSettlementStore({
      now: () => "2026-11-24T12:00:00.000Z",
    });
    const closeChannel = vi.fn(async () => TX_HASH);
    const settler = createStellarChannelSettler({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      feePayer: { envelopeSigner: ENVELOPE_SIGNER },
      maxFeeBumpStroops: 50_000,
      settlementStore,
      readChannelState: async () => ({ balance: "5000" }),
      closeChannel,
    });

    const record = await settler.settle({
      channelId: CHANNEL_1,
      cumulativeAmount: "3200",
      commitment: SIG_HEX,
    });

    expect(record).toEqual({
      channelId: CHANNEL_1,
      settledAmount: "3200",
      returnedRemainder: "1800",
      txHash: TX_HASH,
    });
    expect(closeChannel).toHaveBeenCalledWith({
      channel: CHANNEL_1,
      amount: 3200n,
      signature: decodeCommitmentSignature(SIG_HEX),
      maxFeeBumpStroops: 50_000,
    });

    const marker = await settlementStore.getMarker(CHANNEL_1);
    expect(marker?.status).toBe("settled");
    expect(marker?.txHash).toBe(TX_HASH);
    expect(marker?.returnedRemainder).toBe("1800");
  });

  it("leaves a fail-closed unknown marker on PollTimeoutError and clears on definite pre-send failure", async () => {
    const settlementStore = createInMemoryChannelSettlementStore({
      now: () => "2026-11-24T12:00:00.000Z",
    });

    const pollErr = new Error("Transaction polling timed out");
    pollErr.name = "PollTimeoutError";
    expect(isAmbiguousCloseError(pollErr)).toBe(true);

    const ambiguousSettler = createStellarChannelSettler({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      feePayer: { envelopeSigner: ENVELOPE_SIGNER },
      settlementStore,
      readChannelState: async () => ({ balance: "5000" }),
      closeChannel: async () => {
        throw pollErr;
      },
    });

    await expect(
      ambiguousSettler.settle({
        channelId: CHANNEL_1,
        cumulativeAmount: "1000",
        commitment: SIG_HEX,
      }),
    ).rejects.toThrow("Transaction polling timed out");

    // Marker stays in place as "unknown" so no retry double-submits before reconciliation.
    const marker = await settlementStore.getMarker(CHANNEL_1);
    expect(marker?.status).toBe("unknown");

    // Definite failure clears the marker so a later run can retry.
    const definiteSettler = createStellarChannelSettler({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      feePayer: { envelopeSigner: ENVELOPE_SIGNER },
      settlementStore,
      readChannelState: async () => ({ balance: "5000" }),
      closeChannel: async () => {
        throw new Error("network unreachable");
      },
    });

    await expect(
      definiteSettler.settle({
        channelId: CHANNEL_2,
        cumulativeAmount: "1000",
        commitment: SIG_HEX,
      }),
    ).rejects.toThrow("network unreachable");
    expect(await settlementStore.getMarker(CHANNEL_2)).toBeUndefined();
  });

  it("runs scheduled settlement sweeps and reports stale markers", async () => {
    const voucherStore = createInMemoryVoucherStore();
    await voucherStore.record({
      channelId: CHANNEL_1,
      sequence: 2,
      cumulativeAmount: "2000",
      commitment: SIG_HEX,
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      acceptedAt: "2026-11-24T11:00:00.000Z",
    });
    await voucherStore.record({
      channelId: CHANNEL_2,
      sequence: 1,
      cumulativeAmount: "500",
      commitment: SIG_HEX,
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      acceptedAt: "2026-11-24T11:59:30.000Z",
    });

    const settlementStore = createInMemoryChannelSettlementStore({
      now: () => "2026-11-24T12:00:00.000Z",
    });
    const settler = createStellarChannelSettler({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      feePayer: { envelopeSigner: ENVELOPE_SIGNER },
      settlementStore,
      readChannelState: async () => ({ balance: "5000" }),
      closeChannel: async () => TX_HASH,
    });

    const onSettled = vi.fn();
    const scheduler = createChannelSettlementScheduler({
      voucherStore,
      settler,
      settlementStore,
      intervalMs: 60_000,
      minSettleAmount: "1000",
      onSettled,
      now: () => Date.parse("2026-11-24T12:00:00.000Z"),
    });

    const report = await scheduler.runOnce();
    expect(report.settled).toEqual([
      {
        channelId: CHANNEL_1,
        settledAmount: "2000",
        returnedRemainder: "3000",
        txHash: TX_HASH,
      },
    ]);
    expect(report.skipped).toEqual([CHANNEL_2]);
    expect(report.failed).toEqual([]);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Second sweep skips CHANNEL_1 because it is already settled.
    const report2 = await scheduler.runOnce();
    expect(report2.settled).toEqual([]);
    expect(report2.skipped).toEqual([CHANNEL_1, CHANNEL_2]);
  });
});
