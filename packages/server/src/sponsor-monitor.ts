import { StrKey } from "@stellar/stellar-sdk";
import type {
  SponsorBalanceReading,
  SponsorLowBalanceEvent,
  StellarNetwork,
} from "@vegaforge/tollway-core";
import { getHorizonClient } from "@x402/stellar";
import { z } from "zod";
import { type FacilitatorClient, stellarCaip2 } from "./facilitator.js";
import { parseFacilitatorCapabilities } from "./facilitator-capabilities.js";

/** Reads native XLM as a non-negative integer stroops string. */
export type SponsorBalanceReader = (account: string, network: StellarNetwork) => Promise<string>;

/** Structural bridge to the observability hub, without a dependency on that package. */
export type SponsorMonitorSink = {
  recordSponsorBalance(reading: SponsorBalanceReading): void | Promise<void>;
  /** Async delivery results are awaited; their report remains owned by the sink. */
  emit(event: SponsorLowBalanceEvent): unknown;
};

/** Configuration for observing fee sponsors. Nothing signs or funds an account. */
export type SponsorMonitorOptions = {
  network: StellarNetwork;
  /** Explicit accounts override discovery, including an explicitly empty list. */
  accounts?: readonly string[];
  /** Used for discovery only when accounts are omitted. */
  facilitator?: Pick<FacilitatorClient, "supported">;
  thresholdStroops: string;
  /** Recovery must be strictly above threshold plus this amount. Defaults to zero. */
  hysteresisStroops?: string;
  /** Delay after a completed poll, in milliseconds. Defaults to 60000. */
  intervalMs?: number;
  readBalance?: SponsorBalanceReader;
  sink: SponsorMonitorSink;
  /** Clock for reading and event timestamps. Defaults to Date.now. */
  clock?: () => number;
  /** Background discovery or sink errors. Defaults to console.error. Read errors become stale readings. */
  onError?: (error: unknown) => void;
};

/** A serial poller. stop waits for the current poll; poll also works without a timer. */
export type SponsorMonitor = {
  poll(): Promise<readonly SponsorBalanceReading[]>;
  /** Poll immediately, then schedule after each completion. Repeated starts are idempotent. */
  start(): Promise<void>;
  /** Cancel future timer polls and wait for the in-flight poll, if any. */
  stop(): Promise<void>;
};

/** Minimal Horizon boundary; tests can provide responses without contacting a network. */
export type SponsorHorizonClient = {
  loadAccount(account: string): Promise<unknown>;
};

const stroopsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const horizonSchema = z.object({
  balances: z.array(z.object({ asset_type: z.string(), balance: z.string() })),
});
const xlmSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,7})?$/);

/** Uses @x402/stellar's Horizon client and validates its response before converting XLM. */
export function createHorizonSponsorBalanceReader(
  clientForNetwork: (network: StellarNetwork) => SponsorHorizonClient = (network) =>
    getHorizonClient(stellarCaip2(network)),
): SponsorBalanceReader {
  return async (account, network) => {
    const response = horizonSchema.parse(await clientForNetwork(network).loadAccount(account));
    const native = response.balances.filter((balance) => balance.asset_type === "native");
    if (native.length !== 1 || !native[0]) {
      throw new Error("Horizon account must contain exactly one native XLM balance");
    }
    const balance = xlmSchema.parse(native[0].balance);
    const [whole = "0", fraction = ""] = balance.split(".");
    return (BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"))).toString();
  };
}

function validateAccounts(accounts: readonly string[]): string[] {
  for (const account of accounts) {
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new TypeError(`fee sponsor must be a Stellar G... account: ${account}`);
    }
  }
  return [...new Set(accounts)];
}

/** Watches the native balance promised by docs/design.md, "Design notes" (fee sponsorship). */
export function createSponsorMonitor(options: SponsorMonitorOptions): SponsorMonitor {
  const thresholdStroops = stroopsSchema.parse(options.thresholdStroops);
  const hysteresisStroops = stroopsSchema.parse(options.hysteresisStroops ?? "0");
  const threshold = BigInt(thresholdStroops);
  const recovery = threshold + BigInt(hysteresisStroops);
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new TypeError("intervalMs must be an integer between 1 and 2147483647");
  }
  const network = z.enum(["testnet", "mainnet"]).parse(options.network);
  let accounts = options.accounts === undefined ? undefined : validateAccounts(options.accounts);
  const reader = options.readBalance ?? createHorizonSponsorBalanceReader();
  const now = options.clock ?? Date.now;
  const onError =
    options.onError ?? ((error: unknown) => console.error("Sponsor monitor failed:", error));
  const alerted = new Set<string>();
  let inFlight: Promise<readonly SponsorBalanceReading[]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let generation = 0;

  async function readAccounts(): Promise<string[]> {
    if (accounts !== undefined) return accounts;
    if (!options.facilitator) {
      throw new TypeError("configure explicit sponsor accounts or a facilitator for discovery");
    }
    const capabilities = parseFacilitatorCapabilities(await options.facilitator.supported());
    const discovered = validateAccounts(capabilities.signers[stellarCaip2(network)] ?? []);
    if (discovered.length === 0) {
      throw new Error(
        "facilitator advertises no sponsor signers for this network; configure explicit sponsor accounts",
      );
    }
    // Freeze discovery for this monitor so changing signers do not silently change its scope.
    accounts = discovered;
    return accounts;
  }

  async function sweep(): Promise<readonly SponsorBalanceReading[]> {
    const readings: SponsorBalanceReading[] = [];
    for (const account of await readAccounts()) {
      let reading: SponsorBalanceReading;
      try {
        const balanceStroops = stroopsSchema.parse(await reader(account, network));
        reading = {
          account,
          network,
          at: new Date(now()).toISOString(),
          stale: false,
          balanceStroops,
        };
      } catch (error) {
        reading = {
          account,
          network,
          at: new Date(now()).toISOString(),
          stale: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await options.sink.recordSponsorBalance(reading);
      readings.push(reading);
      if (reading.stale) continue;
      const balance = BigInt(reading.balanceStroops);
      if (balance > recovery) alerted.delete(account);
      if (balance < threshold && !alerted.has(account)) {
        await options.sink.emit({
          type: "sponsor.low_balance",
          at: reading.at,
          data: {
            account,
            network,
            balanceStroops: reading.balanceStroops,
            thresholdStroops,
            hysteresisStroops,
          },
        });
        alerted.add(account);
      }
    }
    return readings;
  }

  function poll(): Promise<readonly SponsorBalanceReading[]> {
    if (inFlight) return inFlight;
    const request = sweep().finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    inFlight = request;
    return request;
  }

  function schedule(epoch: number): void {
    if (!running || epoch !== generation) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Both branches settle the background promise and keep the failure visible.
      void poll().then(
        () => schedule(epoch),
        (error: unknown) => {
          onError(error);
          schedule(epoch);
        },
      );
    }, intervalMs);
    // Node returns a Timeout that would otherwise keep the process alive.
    // Workers, Deno and browsers return a number, which has nothing to unref.
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  }

  return {
    poll,
    async start() {
      if (running) {
        await inFlight;
        return;
      }
      running = true;
      const epoch = ++generation;
      try {
        await poll();
      } catch (error) {
        if (epoch === generation) running = false;
        throw error;
      }
      schedule(epoch);
    },
    async stop() {
      running = false;
      generation++;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
