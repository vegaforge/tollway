import { describe, expect, it } from "vitest";
import { createChannelManager } from "./manager.js";
import { createStellarMppChannelAdapter } from "./stellar-adapter.js";

/**
 * Opt-in integration test against a real one-way-channel contract on Stellar
 * testnet: one open check, at least 10 off-chain commitments, one on-chain
 * close. Skipped unless explicitly enabled. Run with:
 *
 *   TOLLWAY_CHANNEL_INTEGRATION=true \
 *   TOLLWAY_CHANNEL_CONTRACT=C... \
 *   TOLLWAY_CHANNEL_OPEN_TX=<64-hex hash of the deploy/fund transaction> \
 *   TOLLWAY_CHANNEL_COMMITMENT_SEED=<64-hex raw ed25519 seed> \
 *   TOLLWAY_CHANNEL_RECIPIENT=G... \
 *   TOLLWAY_CHANNEL_FEE_PAYER_SECRET=S... \
 *   TOLLWAY_CHANNEL_DEPOSIT=<base units held by the contract> \
 *   pnpm --filter @vegaforge/tollway-channels test stellar-adapter.integration
 *
 * The adapter does not deploy the contract. Deploy and fund the
 * one-way-channel contract first (see the @stellar/mpp channel guide), with
 * the commitment seed's public key as the commitment key and
 * TOLLWAY_CHANNEL_RECIPIENT as the recipient. The fee payer must be a funded
 * testnet account. TOLLWAY_CHANNEL_ASSET optionally pins the token (C...).
 * TOLLWAY_CHANNEL_COMMITS (default 10) and TOLLWAY_CHANNEL_STEP (default
 * 1000 base units) shape the commitment stream.
 */
const RUN = process.env.TOLLWAY_CHANNEL_INTEGRATION === "true";
const env = (name: string): string => process.env[name] ?? "";

describe.skipIf(!RUN)("createStellarMppChannelAdapter (testnet integration)", () => {
  it("opens, signs at least 10 commitments off chain, and closes once", async () => {
    const commits = Number.parseInt(process.env.TOLLWAY_CHANNEL_COMMITS ?? "10", 10);
    const step = process.env.TOLLWAY_CHANNEL_STEP ?? "1000";
    const deposit = env("TOLLWAY_CHANNEL_DEPOSIT");

    const adapter = createStellarMppChannelAdapter({
      channelContract: env("TOLLWAY_CHANNEL_CONTRACT"),
      openTxHash: env("TOLLWAY_CHANNEL_OPEN_TX"),
      commitmentKey: env("TOLLWAY_CHANNEL_COMMITMENT_SEED"),
      feePayer: { envelopeSigner: env("TOLLWAY_CHANNEL_FEE_PAYER_SECRET") },
      network: "testnet",
    });
    const manager = createChannelManager({ adapter });

    const channel = await manager.open({
      counterparty: env("TOLLWAY_CHANNEL_RECIPIENT"),
      asset: process.env.TOLLWAY_CHANNEL_ASSET ?? "",
      deposit,
      network: "testnet",
    });
    expect(channel.id).toBe(env("TOLLWAY_CHANNEL_CONTRACT"));

    let last = "";
    for (let index = 0; index < Math.max(10, commits); index += 1) {
      const commitment = await manager.commit(channel.id, step);
      last = commitment.cumulativeAmount;
    }
    expect(BigInt(last)).toBe(BigInt(step) * BigInt(Math.max(10, commits)));

    const before = await adapter.getChannelState({ channelId: channel.id, network: "testnet" });
    const closed = await manager.close(channel.id);
    expect(closed.settlementTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.returnedRemainder).toBe((BigInt(deposit) - BigInt(last)).toString());

    // The lookup resume relies on (#176) reads the same settlement back
    // from the contract's events.
    const found = await adapter.findChannelSettlement({
      channelId: channel.id,
      network: "testnet",
      startLedger: before.currentLedger,
    });
    expect(found).toMatchObject({
      settlementTxHash: closed.settlementTxHash,
      settledAmount: last,
      returnedRemainder: closed.returnedRemainder,
    });
  }, 180_000);
});
