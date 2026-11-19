import { randomUUID } from "node:crypto";
import { Mppx as MppxClient, stellar as stellarClient } from "@stellar/mpp/charge/client";
import { Store } from "@stellar/mpp/charge/server";
import { Operation } from "@stellar/stellar-sdk";
import {
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  type SettlementModel,
  type SignedReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import {
  createHttpFacilitator,
  createInMemorySettlementCache,
  createMockFacilitator,
  createMppChargeHandler,
  createPaywall,
  decodeHeader,
  type GateOutcome,
  MPP_AUTHORIZATION_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@vegaforge/tollway-server";
import { InsufficientBalanceError } from "@x402/stellar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_STELLAR_ENABLED, readLocalStellarConfig } from "./harness/config.js";
import { startTestFacilitator, type TestFacilitator } from "./harness/facilitator.js";
import {
  balanceOf,
  latestLedger,
  submitOperations,
  toClassicAmount,
  transferTransactions,
} from "./harness/ledger.js";
import { type LocalNetwork, setUpLocalNetwork } from "./harness/local-network.js";
import {
  createX402Payer,
  MAX_TIMEOUT_SECONDS,
  type PaidService,
  SPONSORED_FEES,
  startPaidService,
} from "./harness/service.js";

/**
 * Pays real Soroban transactions through the gate on a disposable local
 * Stellar network (stellar/quickstart). Skipped unless
 * TOLLWAY_LOCAL_STELLAR=true; docs/local-network-tests.md explains how to
 * start the node and run it.
 */

/** Price of the paid route: 0.001 of the test asset in 7-decimal base units. */
const AMOUNT = 10_000n;

/** Per-test budget: a few transactions at one ledger a second, plus margin. */
const TEST_TIMEOUT_MS = 90_000;

describe.skipIf(!LOCAL_STELLAR_ENABLED)("Tollway on a local Stellar network", () => {
  let network: LocalNetwork;
  let facilitator: TestFacilitator;

  beforeAll(async () => {
    const config = readLocalStellarConfig();
    network = await setUpLocalNetwork(config, {
      payerBalance: AMOUNT * 20n,
      shortPayerBalance: AMOUNT,
    });
    facilitator = await startTestFacilitator({
      rpcUrl: network.rpcUrl,
      feePayer: network.facilitator,
    });
    // The readiness deadline covers boot and funding; the rest is a handful
    // of transactions.
  }, readTimeout() + 120_000);

  afterAll(async () => {
    await facilitator?.close();
    await network?.close();
  });

  /** A fresh gate (and so a fresh settlement cache) behind Express, per test. */
  async function startX402Service(): Promise<{ service: PaidService; signer: Ed25519Signer }> {
    const signer = await Ed25519Signer.generate("local-network");
    const gate = createPaywall(
      {
        amount: AMOUNT.toString(),
        asset: network.assetContract,
        payTo: network.recipient.publicKey(),
        network: "testnet",
        models: ["x402"],
      },
      {
        signer,
        facilitator: createHttpFacilitator(facilitator.url, {
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: SPONSORED_FEES,
        }),
        cache: createInMemorySettlementCache(),
      },
    );
    return { service: await startPaidService(gate), signer };
  }

  async function challenge(service: PaidService): Promise<PaymentOffer> {
    const response = await fetch(service.url);
    expect(response.status).toBe(402);
    return decodeHeader<PaymentOffer>(response.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
  }

  function pay(service: PaidService, paymentSignature: string): Promise<Response> {
    return fetch(service.url, { headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignature } });
  }

  async function receiptOf(response: Response): Promise<SignedReceipt> {
    expect(response.status, await response.clone().text()).toBe(200);
    return decodeHeader<SignedReceipt>(response.headers.get(PAYMENT_RESPONSE_HEADER) ?? "");
  }

  function txHashOf(receipt: SignedReceipt): string {
    const { settlement } = receipt.receipt;
    if (settlement.kind !== "transaction") {
      throw new Error(`expected a transaction settlement, got ${settlement.kind}`);
    }
    return settlement.txHash;
  }

  async function balances() {
    const [payer, recipient, shortPayer] = await Promise.all([
      balanceOf(network.server, network.payer.publicKey(), network.asset),
      balanceOf(network.server, network.recipient.publicKey(), network.asset),
      balanceOf(network.server, network.shortPayer.publicKey(), network.asset),
    ]);
    return { payer, recipient, shortPayer };
  }

  /**
   * The first ledger a payment made from now on can land in. The latest
   * ledger is already closed, so starting after it keeps an earlier test's
   * transfer out of this test's count.
   */
  async function nextLedger(): Promise<number> {
    return (await latestLedger(network.server)) + 1;
  }

  function lastOutcome(service: PaidService): GateOutcome {
    const outcome = service.outcomes.at(-1);
    if (!outcome) throw new Error("the gate returned no outcome");
    return outcome;
  }

  describe("x402", () => {
    it(
      "pays a gated Express route end to end and settles once on chain",
      async () => {
        const { service, signer } = await startX402Service();
        try {
          const startLedger = await nextLedger();
          const before = await balances();
          const offer = await challenge(service);
          const payer = createX402Payer({ secret: network.payer.secret(), rpcUrl: network.rpcUrl });

          const receipt = await receiptOf(await pay(service, await payer(offer)));

          const verification = await verifyReceipt(receipt, Ed25519Verifier.forSigner(signer));
          expect(verification.valid).toBe(true);
          expect(receipt.receipt).toMatchObject({
            model: "x402",
            amount: AMOUNT.toString(),
            asset: network.assetContract,
            payee: network.recipient.publicKey(),
            network: "testnet",
          });

          const txHash = txHashOf(receipt);
          const transaction = await network.server.getTransaction(txHash);
          expect(transaction.status).toBe("SUCCESS");

          const after = await balances();
          expect(after.recipient - before.recipient).toBe(AMOUNT);
          expect(before.payer - after.payer).toBe(AMOUNT);
          expect(
            await transferTransactions(network.server, {
              contractId: network.assetContract,
              recipient: network.recipient.publicKey(),
              startLedger,
            }),
          ).toEqual([txHash]);
        } finally {
          await service.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "replays the receipt for the same PAYMENT-SIGNATURE sent twice in sequence",
      async () => {
        const { service } = await startX402Service();
        try {
          const startLedger = await nextLedger();
          const before = await balances();
          const settles = facilitator.calls.settle;
          const offer = await challenge(service);
          const payer = createX402Payer({ secret: network.payer.secret(), rpcUrl: network.rpcUrl });
          const paymentSignature = await payer(offer);

          const first = await receiptOf(await pay(service, paymentSignature));
          expect(lastOutcome(service)).toMatchObject({ kind: "settled", replayed: false });
          const second = await receiptOf(await pay(service, paymentSignature));
          expect(lastOutcome(service)).toMatchObject({ kind: "settled", replayed: true });

          expect(second.receipt.id).toBe(first.receipt.id);
          expect(facilitator.calls.settle - settles).toBe(1);
          const after = await balances();
          expect(after.recipient - before.recipient).toBe(AMOUNT);
          expect(
            await transferTransactions(network.server, {
              contractId: network.assetContract,
              recipient: network.recipient.publicKey(),
              startLedger,
            }),
          ).toEqual([txHashOf(first)]);
        } finally {
          await service.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "settles the same PAYMENT-SIGNATURE sent concurrently once and replays it for the other",
      async () => {
        const { service } = await startX402Service();
        try {
          const startLedger = await nextLedger();
          const before = await balances();
          const settles = facilitator.calls.settle;
          const offer = await challenge(service);
          const payer = createX402Payer({ secret: network.payer.secret(), rpcUrl: network.rpcUrl });
          const paymentSignature = await payer(offer);

          const responses = await Promise.all([
            pay(service, paymentSignature),
            pay(service, paymentSignature),
          ]);
          const receipts = await Promise.all(responses.map(receiptOf));

          const settled = service.outcomes.filter((outcome) => outcome.kind === "settled");
          expect(settled.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
          expect(receipts[1]?.receipt.id).toBe(receipts[0]?.receipt.id);
          expect(facilitator.calls.settle - settles).toBe(1);
          const after = await balances();
          expect(after.recipient - before.recipient).toBe(AMOUNT);
          expect(
            await transferTransactions(network.server, {
              contractId: network.assetContract,
              recipient: network.recipient.publicKey(),
              startLedger,
            }),
          ).toHaveLength(1);
        } finally {
          await service.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rejects a payment the payer can no longer cover, and moves no funds",
      async () => {
        const { service } = await startX402Service();
        try {
          const offer = await challenge(service);
          const shortPayer = createX402Payer({
            secret: network.shortPayer.secret(),
            rpcUrl: network.rpcUrl,
          });
          // The client simulates before signing, so the payment is signed
          // while the balance covers it and the balance is spent afterwards:
          // the facilitator must catch it at /verify, on chain state.
          const paymentSignature = await shortPayer(offer);
          await submitOperations(network.server, network.shortPayer, [
            Operation.payment({
              destination: network.issuer.publicKey(),
              asset: network.asset,
              amount: toClassicAmount(AMOUNT),
            }),
          ]);
          const before = await balances();
          expect(before.shortPayer).toBe(0n);

          const response = await pay(service, paymentSignature);

          expect(response.status).toBe(402);
          expect(lastOutcome(service)).toMatchObject({ kind: "rejected", status: 402 });
          expect(await balances()).toEqual(before);
          // And with nothing left, the client refuses to build a payment at all.
          await expect(shortPayer(offer)).rejects.toBeInstanceOf(InsufficientBalanceError);
        } finally {
          await service.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rejects a payment signed for the wrong amount, and moves no funds",
      async () => {
        const { service } = await startX402Service();
        try {
          const offer = await challenge(service);
          const payer = createX402Payer({ secret: network.payer.secret(), rpcUrl: network.rpcUrl });
          const paymentSignature = await payer(offer, { amount: (AMOUNT - 1n).toString() });
          const before = await balances();

          const response = await pay(service, paymentSignature);

          expect(response.status).toBe(402);
          expect(lastOutcome(service)).toMatchObject({ kind: "rejected", status: 402 });
          expect(await balances()).toEqual(before);
        } finally {
          await service.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("MPP charge (#100)", () => {
    it(
      "pays a gated Express route, settles once on chain and replays a retry",
      async () => {
        const signer = await Ed25519Signer.generate("local-network-mpp");
        const gate = createPaywall(
          {
            amount: AMOUNT.toString(),
            asset: network.assetContract,
            payTo: network.recipient.publicKey(),
            network: "testnet",
            models: ["mpp-charge"],
          },
          {
            signer,
            // MPP charge settles through its own handler; x402 is not offered.
            facilitator: createMockFacilitator(),
            mppChargeHandler: createMppChargeHandler({
              recipient: network.recipient.publicKey(),
              currency: network.assetContract,
              network: "testnet",
              // mppx needs at least 32 bytes; two UUIDs are 73 characters.
              secretKey: `${randomUUID()}-${randomUUID()}`,
              store: Store.memory(),
              rpcUrl: network.rpcUrl,
            }),
            cache: createInMemorySettlementCache(),
          },
        );
        const service = await startPaidService(gate);
        try {
          const startLedger = await nextLedger();
          const before = await balances();
          const challenged = await fetch(service.url);
          expect(challenged.status).toBe(402);

          const agent = MppxClient.create({
            methods: [
              stellarClient.charge({
                secretKey: network.payer.secret(),
                decimals: 0,
                rpcUrl: network.rpcUrl,
              }),
            ],
            polyfill: false,
          });
          // Hand mppx only the MPP challenge. The gate's 402 also carries
          // Tollway's PAYMENT-REQUIRED offer, which mppx 0.8.19's client tries
          // to read as an x402 V2 envelope and throws on (InvalidJsonHeaderError).
          // That interop gap is reported separately; this case covers settlement.
          const mppChallenge = challenged.headers.get("www-authenticate");
          expect(mppChallenge).toMatch(/^Payment /);
          const authorization = await agent.createCredential(
            new Response(null, {
              status: challenged.status,
              headers: { "www-authenticate": mppChallenge ?? "" },
            }),
          );
          const headers = { [MPP_AUTHORIZATION_HEADER]: authorization };

          const first = await receiptOf(await fetch(service.url, { headers }));
          expect(lastOutcome(service)).toMatchObject({ kind: "settled", replayed: false });
          const second = await receiptOf(await fetch(service.url, { headers }));
          expect(lastOutcome(service)).toMatchObject({ kind: "settled", replayed: true });

          expect((await verifyReceipt(first, Ed25519Verifier.forSigner(signer))).valid).toBe(true);
          expect(first.receipt.model).toBe("mpp-charge");
          expect(second.receipt.id).toBe(first.receipt.id);
          const txHash = txHashOf(first);
          expect((await network.server.getTransaction(txHash)).status).toBe("SUCCESS");
          const after = await balances();
          expect(after.recipient - before.recipient).toBe(AMOUNT);
          expect(
            await transferTransactions(network.server, {
              contractId: network.assetContract,
              recipient: network.recipient.publicKey(),
              startLedger,
            }),
          ).toEqual([txHash]);
        } finally {
          await service.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  /**
   * Cases this harness does not cover yet, named so they show up as todo in
   * every run instead of being forgotten. Typed against the settlement
   * models so a renamed model breaks the build here.
   */
  const pending: ReadonlyArray<{ model: SettlementModel; issue: string; why: string }> = [
    {
      model: "mpp-channel",
      issue: "#101",
      why:
        "a channel payment needs the one-way-channel contract deployed on the local network; " +
        "the harness deploys only a Stellar Asset Contract",
    },
  ];
  for (const { model, issue, why } of pending) {
    it.todo(`${model} (${issue}): ${why}`);
  }
});

function readTimeout(): number {
  // Read lazily so a skipped suite never parses its configuration.
  return LOCAL_STELLAR_ENABLED ? readLocalStellarConfig().readyTimeoutMs : 0;
}
