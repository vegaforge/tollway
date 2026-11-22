/**
 * Demo entry point. Selects a scenario by its first argument:
 *
 *   pnpm --filter @vegaforge/tollway-demo start               # x402 (default)
 *   pnpm --filter @vegaforge/tollway-demo start -- x402
 *   pnpm --filter @vegaforge/tollway-demo start -- mpp-charge
 *   pnpm --filter @vegaforge/tollway-demo start -- mpp-channel
 *   pnpm --filter @vegaforge/tollway-demo start -- high-frequency
 *   pnpm --filter @vegaforge/tollway-demo start -- all-models
 *
 * Set MOCK_MODE=true to run entirely offline.
 */

import type { StellarNetwork } from "@vegaforge/tollway-core";
import type { PaywallConfig } from "@vegaforge/tollway-server";
import { createHttpFacilitator, createMockFacilitator } from "@vegaforge/tollway-server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  createEd25519Signer,
  ExactStellarScheme,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "@x402/stellar";
import { DemoConfigError, resolveDemoConfig } from "./config.js";
import { runAllModels } from "./scenarios/all-models.js";
import { runHighFrequencyScenario } from "./scenarios/high-frequency.js";
import { runMppChannelScenario } from "./scenarios/mpp-channel.js";
import { runMppChargeScenario } from "./scenarios/mpp-charge.js";
import type { DemoPayer, ScenarioOptions } from "./scenarios/types.js";
import { runX402Scenario } from "./scenarios/x402.js";

const X402_VERSION = 2;
const MAX_TIMEOUT_SECONDS = 60;
const SPONSORED_FEES = { areFeesSponsored: true };

const NETWORK_CAIP2: Record<StellarNetwork, string> = {
  testnet: STELLAR_TESTNET_CAIP2,
  mainnet: STELLAR_PUBNET_CAIP2,
};

const USDC_ADDRESSES: Record<StellarNetwork, string> = {
  testnet: USDC_TESTNET_ADDRESS,
  mainnet: USDC_PUBNET_ADDRESS,
};

const MOCK_PAYWALL: Pick<PaywallConfig, "asset" | "payTo" | "network"> = {
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
};

const mockPayer: DemoPayer = async (
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => ({
  x402Version: X402_VERSION,
  accepted: requirements,
  payload: { transaction: "mock-signed-auth-entry" },
});

function buildSetup(): ScenarioOptions["setup"] {
  const config = resolveDemoConfig(process.env);

  if (config.mode === "mock") {
    return {
      mock: true,
      facilitator: createMockFacilitator(),
      paywall: MOCK_PAYWALL,
      payer: mockPayer,
    };
  }

  const auth = { Authorization: `Bearer ${config.apiKey}` };
  const signer = createEd25519Signer(
    config.payerSecret,
    NETWORK_CAIP2[config.network] as `${string}:${string}`,
  );
  const scheme = new ExactStellarScheme(signer, config.rpcUrl ? { url: config.rpcUrl } : undefined);
  const payer: DemoPayer = async (requirements) => {
    const { x402Version: version, payload } = await scheme.createPaymentPayload(
      X402_VERSION,
      requirements,
    );
    if (typeof payload.transaction !== "string") {
      throw new Error("@x402/stellar returned a payment payload without a transaction");
    }
    return { x402Version: version, accepted: requirements, payload };
  };

  return {
    mock: false,
    facilitator: createHttpFacilitator(config.facilitatorUrl, {
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: SPONSORED_FEES,
      createAuthHeaders: async () => ({
        verify: auth,
        settle: auth,
        supported: auth,
      }),
    }),
    paywall: {
      asset: USDC_ADDRESSES[config.network],
      payTo: config.recipient,
      network: config.network,
    },
    payer,
  };
}

/** Summary row for the all-models table. */
function summaryRow(
  model: string,
  resource: string,
  amount: string,
  ref: string,
  valid: boolean,
): string {
  const status = valid ? "✓" : "✗";
  return `  ${status}  ${model.padEnd(14)} ${resource.slice(-40).padEnd(40)} ${amount.padStart(10)} ${ref.slice(-20)}`;
}

async function main(): Promise<void> {
  // pnpm passes extra args after `--` as separate argv entries, so
  // `pnpm start -- all-models` gives process.argv = ['tsx', 'main.ts', '--', 'all-models'].
  // Strip a bare `--` separator if present so both `start all-models` and
  // `start -- all-models` work the same way.
  const rawArg = process.argv[2];
  const scenario = rawArg === "--" ? (process.argv[3] ?? "x402") : (rawArg ?? "x402");
  let setup: ScenarioOptions["setup"];

  try {
    setup = buildSetup();
  } catch (err) {
    if (err instanceof DemoConfigError) {
      console.error("Live mode is not configured. Set MOCK_MODE=true to run offline, or fix:");
      for (const problem of err.problems) {
        console.error(`  - ${problem}`);
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const options: ScenarioOptions = { setup };

  console.log(`\nTollway demo — scenario: ${scenario} (${setup.mock ? "MOCK_MODE" : "live"})\n`);

  switch (scenario) {
    case "x402": {
      const result = await runX402Scenario(options);
      console.log(
        summaryRow(
          "x402",
          result.resource,
          result.amount,
          result.settlement ?? "mock",
          result.receiptValid,
        ),
      );
      console.log(`\nReceipt:\n${JSON.stringify(result.receipt, null, 2)}`);
      console.log(`\nReceipt signature valid: ${result.receiptValid}`);
      if (!result.receiptValid) process.exitCode = 1;
      break;
    }

    case "mpp-charge": {
      const result = await runMppChargeScenario(options);
      console.log(
        summaryRow(
          "mpp-charge",
          result.resource,
          result.amount,
          result.settlement ?? "mock",
          result.receiptValid,
        ),
      );
      console.log(`\nReceipt:\n${JSON.stringify(result.receipt, null, 2)}`);
      console.log(`\nReceipt signature valid: ${result.receiptValid}`);
      if (!result.receiptValid) process.exitCode = 1;
      break;
    }

    case "mpp-channel": {
      const result = await runMppChannelScenario(options);
      console.log(`Channel id: ${result.channelId}`);
      console.log(`Commitments: ${result.commitments.length}`);
      console.log(`Settlement tx: ${result.settlementTxHash}`);
      console.log(`Reconciliation: ${result.reconciliationOk ? "ok" : "FAILED"}`);
      const allValid = result.commitments.every((c) => c.receiptValid);
      if (!allValid || !result.reconciliationOk) process.exitCode = 1;
      break;
    }

    case "high-frequency": {
      const n = process.env.HF_N ? Number.parseInt(process.env.HF_N, 10) : 500;
      const result = await runHighFrequencyScenario(options, { n });
      console.log(`Channel id:    ${result.channelId}`);
      console.log(`Commitments:   ${result.n}`);
      console.log(`Throughput:    ${result.throughputCommitmentsPerSecond.toFixed(1)} commits/s`);
      console.log(`p50 latency:   ${result.p50LatencyMs.toFixed(2)} ms`);
      console.log(`p95 latency:   ${result.p95LatencyMs.toFixed(2)} ms`);
      console.log(`Settlement tx: ${result.settlementTxHash}`);
      console.log(`Settled total: ${result.settledTotal}`);
      console.log(`Reconcile:     ${result.reconciliationOk ? "ok" : "FAILED"}`);
      console.log(`Opens: ${result.openChannelCalls}  Closes: ${result.closeChannelCalls}`);
      if (!result.reconciliationOk) process.exitCode = 1;
      break;
    }

    case "all-models": {
      const { results, allPassed } = await runAllModels(options);
      console.log(
        `  ${"ok".padEnd(4)} ${"model".padEnd(14)} ${"resource".padEnd(40)} ${"amount".padStart(10)} ${"reference"}`,
      );
      console.log(`  ${"-".repeat(76)}`);
      for (const r of results) {
        if (r.scenario === "x402" || r.scenario === "mpp-charge") {
          console.log(
            summaryRow(r.scenario, r.resource, r.amount, r.settlement ?? "mock", r.receiptValid),
          );
        } else if (r.scenario === "mpp-channel") {
          const allValid = r.commitments.every((c) => c.receiptValid) && r.reconciliationOk;
          console.log(
            summaryRow(
              "mpp-channel",
              r.channelId,
              `${r.commitments.length} commits`,
              r.settlementTxHash.slice(0, 20),
              allValid,
            ),
          );
        } else if (r.scenario === "high-frequency") {
          console.log(
            summaryRow(
              "high-frequency",
              r.channelId,
              r.settledTotal,
              r.settlementTxHash.slice(0, 20),
              r.reconciliationOk,
            ),
          );
        }
      }
      console.log(`\nAll passed: ${allPassed}`);
      if (!allPassed) process.exitCode = 1;
      break;
    }

    default:
      console.error(
        `Unknown scenario "${scenario}". Valid options: x402, mpp-charge, mpp-channel, high-frequency, all-models`,
      );
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof DemoConfigError) {
    console.error("Live mode is not configured. Set MOCK_MODE=true to run offline, or fix:");
    for (const problem of error.problems) {
      console.error(`  - ${problem}`);
    }
  } else {
    console.error("Demo failed:", error);
  }
  process.exitCode = 1;
});
