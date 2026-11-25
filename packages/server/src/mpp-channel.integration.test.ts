import { Mppx as MppxClient, stellar as stellarClient } from "@stellar/mpp/channel/client";
import { Store } from "@stellar/mpp/channel/server";
import { Keypair } from "@stellar/stellar-sdk";
import { Ed25519Signer } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createChannelSettler } from "./channel-settlement.js";
import { createInMemoryChannelStore, createInMemoryCloseRateGuard } from "./channel-store.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall } from "./gate.js";
import { createMppChannelHandler } from "./mpp-channel.js";

/**
 * Opt-in integration test: accepts several vouchers on a real one-way
 * channel on Stellar testnet through the gate, then closes it once, so it is
 * skipped unless explicitly enabled. Run with:
 *
 *   TOLLWAY_MPP_CHANNEL_INTEGRATION=true \
 *   TOLLWAY_MPP_CHANNEL=C... \
 *   TOLLWAY_MPP_COMMITMENT_SECRET=S... \
 *   TOLLWAY_MPP_RECIPIENT_SECRET=S... \
 *   pnpm --filter @vegaforge/tollway-server test mpp-channel.integration
 *
 * The channel must be a deployed stellar-experimental/one-way-channel
 * contract, funded by its funder, paying out to the recipient's account in
 * the charged token (testnet USDC by default; override with
 * TOLLWAY_MPP_CURRENCY). The commitment secret is the funder's commitment
 * key. The recipient secret pays the close fee and must hold XLM and a
 * trustline for the token. TOLLWAY_MPP_AMOUNT sets the price in base units
 * (default 10000). The channel's refund waiting period must be at least
 * TOLLWAY_MPP_MIN_REFUND_PERIOD ledgers (default 1 here, so short testnet
 * channels work). The test closes the channel: deploy a new one per run.
 */
const RUN = process.env.TOLLWAY_MPP_CHANNEL_INTEGRATION === "true";
const CHANNEL = process.env.TOLLWAY_MPP_CHANNEL ?? "";
const COMMITMENT_SECRET = process.env.TOLLWAY_MPP_COMMITMENT_SECRET ?? "";
const RECIPIENT_SECRET = process.env.TOLLWAY_MPP_RECIPIENT_SECRET ?? "";
const CURRENCY =
  process.env.TOLLWAY_MPP_CURRENCY ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT = process.env.TOLLWAY_MPP_AMOUNT ?? "10000";
const MIN_REFUND_PERIOD = Number(process.env.TOLLWAY_MPP_MIN_REFUND_PERIOD ?? "1");

describe.skipIf(!RUN)("mpp-channel gate and settlement (testnet integration)", () => {
  it("accepts three vouchers, replays one, and closes the channel once", async () => {
    const recipient = Keypair.fromSecret(RECIPIENT_SECRET);
    const channels = createInMemoryChannelStore();
    const closeRateGuard = createInMemoryCloseRateGuard({ maxCloses: 1, windowMs: 3_600_000 });
    const gate = createPaywall(
      {
        amount: AMOUNT,
        asset: CURRENCY,
        payTo: recipient.publicKey(),
        network: "testnet",
        models: ["mpp-channel"],
      },
      {
        signer: await Ed25519Signer.generate("mpp-channel-integration"),
        facilitator: createMockFacilitator(),
        mppChannelHandler: createMppChannelHandler({
          recipient: recipient.publicKey(),
          currency: CURRENCY,
          network: "testnet",
          secretKey: crypto.randomUUID(),
          store: Store.memory(),
          channels,
          minRefundWaitingPeriod: MIN_REFUND_PERIOD,
        }),
        cache: createInMemorySettlementCache(),
      },
    );
    const agent = MppxClient.create({
      methods: [
        stellarClient.channel({ commitmentSecret: COMMITMENT_SECRET, allowedChannels: [CHANNEL] }),
      ],
      polyfill: false,
    });
    const request = { method: "GET", url: "/integration/resource" };

    let last = "";
    for (let i = 1; i <= 3; i += 1) {
      const challenged = await gate({ ...request, headers: { "tollway-channel": CHANNEL } });
      expect(challenged.kind).toBe("payment-required");
      if (challenged.kind !== "payment-required") return;
      last = await agent.createCredential(
        new Response(null, { status: challenged.status, headers: challenged.headers }),
      );
      const settled = await gate({ ...request, headers: { authorization: last } });
      expect(settled.kind).toBe("settled");
      if (settled.kind !== "settled") return;
      expect(settled.receipt.receipt.settlement).toEqual({
        kind: "channel-commitment",
        channelId: CHANNEL,
        sequence: i,
      });
    }

    const replayed = await gate({ ...request, headers: { authorization: last } });
    expect(replayed.kind === "settled" && replayed.replayed).toBe(true);

    const settler = createChannelSettler({
      channels,
      network: "testnet",
      feePayer: { envelopeSigner: recipient },
      feePayerKey: recipient.publicKey(),
      closeRateGuard,
    });
    const closed = await settler.settle(CHANNEL);
    expect(closed).toMatchObject({
      status: "closed",
      record: { channelId: CHANNEL, settledAmount: String(BigInt(AMOUNT) * 3n) },
    });
    expect((await settler.settle(CHANNEL)).status).toBe("already-closed");
  }, 180_000);
});
