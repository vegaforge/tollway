/**
 * The budget-capped agent demo: docs/design.md, Phase 3, as a runnable flow.
 *
 * An agent with a declarative policy pays a gated service until its daily
 * budget runs out and is stopped with a typed error; a spend spike trips the
 * per-minute anomaly stop; and two channel drift cases are flagged, one by the
 * channel manager's in-process close guard and one by the reconciler.
 *
 * Mock mode runs the whole flow offline over local HTTP with the mock
 * facilitator and a demo-local settler. The same scenario is what the tests
 * assert on, so the narrative and the checks cannot drift apart.
 */

import type { AddressInfo } from "node:net";
import { expressPaywall } from "@vegaforge/tollway-adapter-express";
import {
  type ChannelStatus,
  createChannelManager,
  type MppChannelAdapter,
  SettlementMismatchError,
} from "@vegaforge/tollway-channels";
import { createClient, type PayRequest, PolicyBlockedError } from "@vegaforge/tollway-client";
import {
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  type Policy,
  type SettlementModel,
  type SignedReceipt,
  type StellarNetwork,
} from "@vegaforge/tollway-core";
import { createObservabilityHub, type TollwayEvent } from "@vegaforge/tollway-observability";
import {
  createReconciler,
  type Drift,
  type DriftKind,
  type ReconciliationResult,
} from "@vegaforge/tollway-reconcile";
import {
  createInMemorySettlementCache,
  createMockFacilitator,
  createPaywall,
  type FacilitatorClient,
  type PaywallConfig,
} from "@vegaforge/tollway-server";
import express from "express";
import { createMockSettler } from "./mock-settler.js";

/** The route price: 0.001 USDC, in 7-decimal base units. */
export const ROUTE_PRICE = "10000";

/** How many payments fit in the daily budget before one is refused. */
export const PAYMENTS_IN_BUDGET = 3;

/** Deterministic start of the injected clock. */
const CLOCK_START = Date.parse("2026-11-25T12:00:00.000Z");

const ASSET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const PAY_TO = "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const NETWORK: StellarNetwork = "testnet";
const MODEL: SettlementModel = "x402";

const CHANNEL_ID = `C${"A".repeat(55)}`;
const CHANNEL_DEPOSIT = "50000";
const CHANNEL_COMMITMENT = ROUTE_PRICE;
const CHANNEL_SETTLED = "25000";

/**
 * Phase 1. The daily budget is exactly the price times the number of payments
 * the agent may make, so payment K succeeds and payment K+1 is refused with
 * `rule: "budget"`.
 */
export const BUDGET_STOP_POLICY: Policy = {
  mode: "enforce",
  budgets: { daily: (BigInt(ROUTE_PRICE) * BigInt(PAYMENTS_IN_BUDGET)).toString() },
  perModel: { x402: { enabled: true } },
};

/**
 * Phase 2. The operator raises the daily budget and adds a per-minute anomaly
 * stop. The route price is 10 000, so two payments fit under 25 000 and the
 * third's projected minute spend (30 000) is refused with `rule: "anomaly"`.
 */
export const ANOMALY_STOP_POLICY: Policy = {
  mode: "enforce",
  budgets: { daily: "100000" },
  anomaly: { maxSpendPerMinute: "25000" },
  perModel: { x402: { enabled: true } },
};

/** One policy-refused payment attempt. `index` is 1-based. */
export type PolicyStop = {
  index: number;
  rule: string;
  detail: string;
};

export type BudgetPhaseResult = {
  policy: Policy;
  price: string;
  dailyBudget: string;
  /** Receipts that settled, in order. */
  settled: SignedReceipt[];
  blocked: PolicyStop;
  /** Calls the gate made to the facilitator's `/verify` for this phase. */
  facilitatorVerifyCalls: number;
  facilitatorSettleCalls: number;
  /** The budget rule's recorded spend after the refused attempt. */
  spentAfterBlock: string;
  /** A later check for an amount that fits the remaining budget. */
  probeAllowed: boolean;
  /** The client's `skip` event reasons. */
  skips: string[];
};

export type AnomalyPhaseResult = {
  policy: Policy;
  price: string;
  maxSpendPerMinute: string;
  settled: SignedReceipt[];
  blocked: PolicyStop;
  facilitatorVerifyCalls: number;
  skips: string[];
};

export type DriftFinding = {
  kind: DriftKind;
  detail: string;
  /** Only set for `under-settled`: committed minus settled, in base units. */
  shortfall: string | null;
};

export type DriftPhaseResult = {
  channelId: string;
  commitments: number;
  deposit: string;
  /** The manager's close guard: what it expected and what the adapter reported. */
  closeRefused: { expectedSettled: string; actualSettled: string };
  channelStatusAfterRefusal: ChannelStatus;
  underSettled: DriftFinding;
  sequenceGap: DriftFinding;
  /** One `anomaly.detected` delivery per drift finding. */
  anomalyEvents: number;
};

export type BudgetCappedResult = {
  mock: true;
  budget: BudgetPhaseResult;
  anomaly: AnomalyPhaseResult;
  drift: DriftPhaseResult;
  narrative: string[];
};

export type BudgetCappedOptions = {
  /** Called once per narrative line. Omit to keep the run quiet (tests). */
  print?: (line: string) => void;
};

type FacilitatorCounts = { verify: number; settle: number };

type GatedService = {
  resource: string;
  offer: PaymentOffer;
  signer: Ed25519Signer;
  counts: FacilitatorCounts;
  close: () => Promise<void>;
};

/**
 * Counts what the gate asks the facilitator. The scenario asserts these
 * counts, and they are also how an operator sees that a refused request never
 * reached the service.
 */
function withCounts(inner: FacilitatorClient): {
  facilitator: FacilitatorClient;
  counts: FacilitatorCounts;
} {
  const counts: FacilitatorCounts = { verify: 0, settle: 0 };
  const facilitator: FacilitatorClient = {
    async verify(input) {
      counts.verify += 1;
      return inner.verify(input);
    },
    async settle(input) {
      counts.settle += 1;
      return inner.settle(input);
    },
    async supported() {
      return inner.supported();
    },
  };
  const idempotencyKey = inner.idempotencyKey;
  if (idempotencyKey) {
    facilitator.idempotencyKey = (input) => idempotencyKey(input);
  }
  return { facilitator, counts };
}

/** Starts the paid route on an ephemeral port, behind the real Express adapter. */
async function startGatedService(): Promise<GatedService> {
  const signer = await Ed25519Signer.generate("tollway-demo-budget-capped");
  const { facilitator, counts } = withCounts(createMockFacilitator());
  const config: PaywallConfig = {
    amount: ROUTE_PRICE,
    asset: ASSET,
    payTo: PAY_TO,
    network: NETWORK,
    models: [MODEL],
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
  const gate = createPaywall(config, {
    signer,
    facilitator,
    cache: createInMemorySettlementCache(),
  });

  const app = express();
  app.get("/quotes/latest", expressPaywall(gate), (_req, res) => {
    res.json({ symbol: "XLM/USD", price: "0.1234" });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const resource = `http://127.0.0.1:${port}/quotes/latest`;

  return {
    resource,
    offer: {
      resource,
      amount: ROUTE_PRICE,
      asset: ASSET,
      payTo: PAY_TO,
      network: NETWORK,
      models: [MODEL],
    },
    signer,
    counts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function intentFor(service: GatedService, amount: string) {
  return {
    payee: PAY_TO,
    resource: service.resource,
    amount,
    asset: ASSET,
    model: MODEL,
  };
}

type AttemptResult = { settled: SignedReceipt[]; blocked: PolicyStop | undefined };

/**
 * Pays sequentially, which is what the policy engine supports today: the
 * check-then-record race for concurrent payments is #189. Stops at the first
 * typed policy refusal.
 */
async function payUntilBlocked(
  service: GatedService,
  client: ReturnType<typeof createClient>,
  attempts: number,
  say: (line: string) => void,
): Promise<AttemptResult> {
  const settled: SignedReceipt[] = [];
  const request: PayRequest = { resource: service.resource, offer: service.offer };

  for (let index = 1; index <= attempts; index += 1) {
    try {
      const { receipt } = await client.pay(request);
      settled.push(receipt);
      const settlement = receipt.receipt.settlement;
      const where = settlement.kind === "transaction" ? settlement.txHash : settlement.channelId;
      say(
        `   ${index}. paid ${receipt.receipt.amount} ${MODEL} -> 200, receipt ${where.slice(0, 16)}...`,
      );
    } catch (error) {
      if (!(error instanceof PolicyBlockedError)) throw error;
      say(`   ${index}. refused before payment: ${error.rule}: ${error.detail}`);
      return { settled, blocked: { index, rule: error.rule, detail: error.detail } };
    }
  }

  return { settled, blocked: undefined };
}

async function runBudgetPhase(
  service: GatedService,
  settler: ReturnType<typeof createMockSettler>,
  say: (line: string) => void,
): Promise<BudgetPhaseResult> {
  const countsBefore = { ...service.counts };
  const engine = createPolicyEngineFor(BUDGET_STOP_POLICY);
  const client = createClient({
    network: NETWORK,
    settler,
    policy: engine,
    verifier: Ed25519Verifier.forSigner(service.signer),
    logger: { warn: () => {} },
  });
  const skips: string[] = [];
  client.on((event) => {
    if (event.type === "skip") skips.push(event.reason);
  });

  say("");
  say("Phase 1: a daily budget of K times the route price");
  say(`   policy: ${JSON.stringify(BUDGET_STOP_POLICY)}`);
  say(`   price ${ROUTE_PRICE} per request, daily budget ${BUDGET_STOP_POLICY.budgets?.daily}`);

  const attempt = await payUntilBlocked(service, client, PAYMENTS_IN_BUDGET + 1, say);
  if (!attempt.blocked) {
    throw new Error("the agent was never stopped; the demo relies on a budget refusal here");
  }

  // The refused evaluation must not have recorded spend. Reading the budget
  // rule's own trace shows the engine's view, not the demo's arithmetic.
  const trace = await engine.evaluate(intentFor(service, ROUTE_PRICE));
  const budgetEntry = trace.entries.find((entry) => entry.id === "budget-daily");
  if (budgetEntry?.current == null) {
    throw new Error("the budget-daily trace entry is missing its spend");
  }

  // A zero-priced resource only fits if the refused attempt recorded nothing.
  // With the budget exhausted, any recorded partial spend would block even 0.
  const probe = await engine.check(intentFor(service, "0"));

  say(
    `   facilitator: ${service.counts.verify - countsBefore.verify} verify calls, so request ${attempt.blocked.index} never reached the service`,
  );
  say(
    `   spend still ${budgetEntry.current} after the refusal; a smaller check fits: ${probe.allowed}`,
  );

  return {
    policy: BUDGET_STOP_POLICY,
    price: ROUTE_PRICE,
    dailyBudget: BUDGET_STOP_POLICY.budgets?.daily ?? "",
    settled: attempt.settled,
    blocked: attempt.blocked,
    facilitatorVerifyCalls: service.counts.verify - countsBefore.verify,
    facilitatorSettleCalls: service.counts.settle - countsBefore.settle,
    spentAfterBlock: budgetEntry.current,
    probeAllowed: probe.allowed,
    skips,
  };
}

async function runAnomalyPhase(
  service: GatedService,
  settler: ReturnType<typeof createMockSettler>,
  say: (line: string) => void,
): Promise<AnomalyPhaseResult> {
  const countsBefore = { ...service.counts };
  // A policy change builds a new engine, so this phase starts a fresh spend
  // window. The daily budget is raised so the anomaly rule is what stops it.
  const engine = createPolicyEngineFor(ANOMALY_STOP_POLICY);
  const client = createClient({
    network: NETWORK,
    settler,
    policy: engine,
    verifier: Ed25519Verifier.forSigner(service.signer),
    logger: { warn: () => {} },
  });
  const skips: string[] = [];
  client.on((event) => {
    if (event.type === "skip") skips.push(event.reason);
  });

  say("");
  say("Phase 2: the operator raises the budget and caps spend per minute");
  say(`   policy: ${JSON.stringify(ANOMALY_STOP_POLICY)}`);
  say("   the injected clock stays inside one minute, so the burst is deterministic");

  const attempt = await payUntilBlocked(service, client, PAYMENTS_IN_BUDGET + 1, say);
  if (!attempt.blocked) {
    throw new Error("the burst was never stopped; the demo relies on an anomaly refusal here");
  }

  say(`   facilitator: ${service.counts.verify - countsBefore.verify} verify calls for this phase`);

  return {
    policy: ANOMALY_STOP_POLICY,
    price: ROUTE_PRICE,
    maxSpendPerMinute: ANOMALY_STOP_POLICY.anomaly?.maxSpendPerMinute ?? "",
    settled: attempt.settled,
    blocked: attempt.blocked,
    facilitatorVerifyCalls: service.counts.verify - countsBefore.verify,
    skips,
  };
}

/**
 * An offline channel adapter. `closeChannel` reports what actually settled on
 * chain; here that is deliberately less than the last commitment, which is the
 * drift the demo is about.
 */
function createOfflineAdapter(settledAmount: string): MppChannelAdapter {
  return {
    async openChannel() {
      return { channelId: CHANNEL_ID, openTxHash: "0".repeat(64) };
    },
    async signCommitment({ cumulativeAmount }) {
      return { commitment: `offline-commitment:${cumulativeAmount}` };
    },
    async closeChannel() {
      return {
        settlementTxHash: "offline-under-settled-close",
        settledAmount,
        returnedRemainder: String(BigInt(CHANNEL_DEPOSIT) - BigInt(settledAmount)),
      };
    },
  };
}

function driftOf(result: ReconciliationResult, kind: DriftKind): Drift {
  if (result.ok) {
    throw new Error(`expected a ${kind} drift, but reconciliation reported no drift`);
  }
  const drift = result.drift.find((item) => item.kind === kind);
  if (!drift) {
    throw new Error(
      `expected a ${kind} drift, got: ${result.drift.map((item) => item.kind).join(", ")}`,
    );
  }
  return drift;
}

async function runDriftPhase(say: (line: string) => void): Promise<DriftPhaseResult> {
  const manager = createChannelManager({
    adapter: createOfflineAdapter(CHANNEL_SETTLED),
    now: () => new Date(CLOCK_START).toISOString(),
  });
  const channel = await manager.open({
    counterparty: PAY_TO,
    asset: ASSET,
    deposit: CHANNEL_DEPOSIT,
    network: NETWORK,
  });
  for (let index = 0; index < PAYMENTS_IN_BUDGET; index += 1) {
    await manager.commit(channel.id, CHANNEL_COMMITMENT);
  }
  const commitments = [...(await manager.list(channel.id))];

  say("");
  say("Phase 3: channel drift, off-chain commitments versus the on-chain close");
  say(
    `   channel ${channel.id} deposit ${CHANNEL_DEPOSIT}, ${commitments.length} commitments, last cumulative ${commitments.at(-1)?.cumulativeAmount}`,
  );

  let closeRefused: { expectedSettled: string; actualSettled: string } | undefined;
  try {
    await manager.close(channel.id);
  } catch (error) {
    if (!(error instanceof SettlementMismatchError)) throw error;
    closeRefused = {
      expectedSettled: error.expectedSettled,
      actualSettled: error.actualSettled,
    };
    say(
      `   manager refused the close: expected ${error.expectedSettled}, adapter reported ${error.actualSettled}`,
    );
  }
  if (!closeRefused) {
    throw new Error("the manager closed a channel whose settlement did not match its commitment");
  }
  const afterRefusal = await manager.get(channel.id);
  if (!afterRefusal) throw new Error(`channel ${channel.id} disappeared after the refused close`);
  say(`   channel rolled back to "${afterRefusal.status}", so the operator can retry`);

  const records = commitments.map((commitment) => ({
    channelId: commitment.channelId,
    sequence: commitment.sequence,
    cumulativeAmount: commitment.cumulativeAmount,
  }));
  const last = records.at(-1);
  if (!last) throw new Error("the channel has no commitments; the drift phase needs at least one");
  const shortfall = (BigInt(last.cumulativeAmount) - BigInt(CHANNEL_SETTLED)).toString();

  const reconciler = createReconciler();
  const under = await reconciler.reconcileChannel(records, {
    channelId: channel.id,
    settledAmount: CHANNEL_SETTLED,
    returnedRemainder: String(BigInt(CHANNEL_DEPOSIT) - BigInt(CHANNEL_SETTLED)),
    txHash: "offline-under-settled-close",
  });
  const underSettled = driftOf(under, "under-settled");
  say(`   reconciler: ${underSettled.kind}, shortfall ${shortfall}`);
  say(`   ${underSettled.detail}`);

  // The second case: a commitment is missing from the stored stream. The
  // settlement matches the last commitment, so the gap is the only drift.
  const gapped = records.filter((record) => record.sequence !== 1);
  const gap = await reconciler.reconcileChannel(gapped, {
    channelId: channel.id,
    settledAmount: last.cumulativeAmount,
    returnedRemainder: String(BigInt(CHANNEL_DEPOSIT) - BigInt(last.cumulativeAmount)),
    txHash: "offline-sequence-gap",
  });
  const sequenceGap = driftOf(gap, "sequence-gap");
  say(`   reconciler: ${sequenceGap.kind}, no shortfall in this case`);
  say(`   ${sequenceGap.detail}`);

  const hub = createObservabilityHub();
  const received: TollwayEvent[] = [];
  hub.on("anomaly.detected", (event) => {
    received.push(event);
    say(`   hub handler received anomaly.detected: ${JSON.stringify(event.data)}`);
  });
  await hub.emit(anomalyEvent(channel.id, underSettled, shortfall));
  await hub.emit(anomalyEvent(channel.id, sequenceGap, null));

  return {
    channelId: channel.id,
    commitments: records.length,
    deposit: CHANNEL_DEPOSIT,
    closeRefused,
    channelStatusAfterRefusal: afterRefusal.status,
    underSettled: { kind: underSettled.kind, detail: underSettled.detail, shortfall },
    sequenceGap: { kind: sequenceGap.kind, detail: sequenceGap.detail, shortfall: null },
    anomalyEvents: received.length,
  };
}

function anomalyEvent(channelId: string, drift: Drift, shortfall: string | null): TollwayEvent {
  return {
    type: "anomaly.detected",
    at: new Date(CLOCK_START).toISOString(),
    data: {
      channelId,
      drift: drift.kind,
      detail: drift.detail,
      ...(shortfall === null ? {} : { shortfall }),
    },
  };
}

/**
 * Runs the three phases and returns a typed result plus the narrative lines.
 * All payments are sequential and the clock is injected, so a run is
 * deterministic; `MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo
 * start:budget-capped` prints it.
 */
export async function runBudgetCappedScenario(
  options: BudgetCappedOptions = {},
): Promise<BudgetCappedResult> {
  const narrative: string[] = [];
  const say = (line: string) => {
    narrative.push(line);
    options.print?.(line);
  };

  say("Tollway budget-capped agent demo (MOCK_MODE, deterministic clock)");
  say("An agent pays a gated quote until policy stops it, then channel drift is reconciled.");

  const service = await startGatedService();
  // One settler for both policy phases: its payment counter keeps each
  // settlement's transaction distinct, which keeps the gate's idempotency
  // cache from answering a later phase with an earlier receipt.
  const settler = createMockSettler();

  try {
    const budget = await runBudgetPhase(service, settler, say);
    const anomaly = await runAnomalyPhase(service, settler, say);
    const drift = await runDriftPhase(say);

    say("");
    say("Summary");
    say(
      `   budget stop: payment ${budget.blocked.index}, rule ${budget.blocked.rule}, ${budget.facilitatorVerifyCalls} verify calls`,
    );
    say(
      `   anomaly stop: payment ${anomaly.blocked.index}, rule ${anomaly.blocked.rule}, ${anomaly.facilitatorVerifyCalls} verify calls`,
    );
    say(
      `   drift: ${drift.underSettled.kind} (shortfall ${drift.underSettled.shortfall}) and ${drift.sequenceGap.kind}`,
    );
    say(`   anomaly.detected emitted ${drift.anomalyEvents} time(s)`);

    return { mock: true, budget, anomaly, drift, narrative };
  } finally {
    await service.close();
  }
}

/** One place for the clock so every phase is deterministic and testable. */
function createPolicyEngineFor(policy: Policy) {
  return createPolicyEngine(policy, { clock: () => CLOCK_START });
}
