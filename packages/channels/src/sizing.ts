/**
 * Channel deposit sizing (#181). Turns the price of a request, the observed
 * traffic, a time horizon and the policy's remaining headroom into a deposit,
 * or a decision not to open a channel at all. See docs/design.md, "The channel
 * lifecycle manager".
 *
 * The function is pure: no I/O and no clock. Every input is explicit, so the
 * result can be tested exhaustively. It does not open a channel. The caller
 * supplies the traffic snapshot and the headroom, for example from
 * `PolicyEngine.headroom`.
 *
 * Amounts are integer strings in the asset's base units and are computed as
 * `bigint`. The request rate is the only fractional input. It is converted
 * once, here, to whole millionths of a request per minute.
 */

import { TollwayError, type TrafficSnapshot } from "@vegaforge/tollway-core";

/** Requests per minute are rounded to this many steps per request (one millionth). */
export const RATE_PRECISION = 1_000_000;

/** Basis points in one whole: 10000 bps is 1.0. */
const WHOLE_BPS = 10_000n;

export type SizeDepositInput = {
  /** What one request costs, as an integer string in base units. */
  pricePerRequest: string;
  /**
   * Observed traffic. `requestsPerMinute` drives the deposit. `windowSeconds`
   * must be positive, and is otherwise not used.
   */
  traffic: TrafficSnapshot;
  /** How many seconds of predicted demand the deposit should cover. A positive integer. */
  horizonSeconds: number;
  /**
   * Multiplier on predicted demand, in basis points. 10000 is exactly the
   * predicted demand, and 12000 is 20 percent more. At least 10000.
   */
  safetyFactorBps: number;
  /** The largest deposit the caller allows, as an integer string. Optional. */
  maximum?: string;
  /**
   * The smallest deposit policy accepts, as an integer string. The result
   * never goes below it. Use "0" when the policy sets no minimum.
   */
  minDeposit: string;
  /**
   * What the policy still allows for this asset and payee, from
   * `PolicyEngine.headroom`. Null means the policy sets no ceiling.
   */
  headroom: string | null;
};

export type SizeDepositDecision =
  | { open: true; deposit: string; reason: string }
  | { open: false; reason: string };

function parseAmount(value: string, field: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new TollwayError(
      "invalid-amount",
      `${field} "${value}" is not a valid non-negative integer string`,
    );
  }
  return BigInt(value);
}

function assertAtLeast(value: number, field: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TollwayError("invalid-policy", `${field} must be an integer of at least ${min}`);
  }
}

/**
 * Sizes a channel deposit to predicted demand over the horizon, with the safety
 * factor applied, then clamps it to the minimum and to the tighter of the
 * maximum and the headroom.
 *
 * Demand is `price × requests-per-minute × minutes × safety factor`, rounded up
 * so the deposit never undershoots the demand. A deposit below the minimum is
 * raised to it. A deposit above the tighter of `maximum` and `headroom` is
 * lowered to it.
 *
 * The result is `open: false` when there is no predicted demand (zero traffic or
 * a zero price), when the headroom leaves no room for a positive deposit, or
 * when the headroom is below the minimum. A channel that locks funds nobody
 * will spend is not worth opening.
 *
 * Throws `invalid-amount` for an amount that is not an integer string, and
 * `invalid-policy` for a configuration error, such as a maximum below the
 * minimum deposit.
 */
export function sizeDeposit(input: SizeDepositInput): SizeDepositDecision {
  const price = parseAmount(input.pricePerRequest, "pricePerRequest");
  const minDeposit = parseAmount(input.minDeposit, "minDeposit");
  const maximum = input.maximum === undefined ? undefined : parseAmount(input.maximum, "maximum");
  const headroom = input.headroom === null ? undefined : parseAmount(input.headroom, "headroom");
  assertAtLeast(input.horizonSeconds, "horizonSeconds", 1);
  assertAtLeast(input.safetyFactorBps, "safetyFactorBps", Number(WHOLE_BPS));

  const { requestsPerMinute, windowSeconds } = input.traffic;
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute < 0) {
    throw new TollwayError(
      "invalid-policy",
      "traffic.requestsPerMinute must be a finite, non-negative number",
    );
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new TollwayError("invalid-policy", "traffic.windowSeconds must be a positive number");
  }
  const scaledRate = Math.round(requestsPerMinute * RATE_PRECISION);
  if (!Number.isFinite(scaledRate)) {
    throw new TollwayError("invalid-policy", "traffic.requestsPerMinute is too large to size");
  }

  if (maximum !== undefined && maximum < minDeposit) {
    throw new TollwayError(
      "invalid-policy",
      `maximum deposit ${maximum} is below the minimum channel deposit ${minDeposit}`,
    );
  }

  const ratePerMillion = BigInt(scaledRate);
  if (ratePerMillion === 0n || price === 0n) {
    return { open: false, reason: "no predicted demand: the traffic rate or the price is zero" };
  }

  // Requests over the horizon are rate × horizon / 60, so demand is
  // price × rate × horizon / 60, times the factor. Work in millionths and bps,
  // and round up.
  const numerator =
    price * ratePerMillion * BigInt(input.horizonSeconds) * BigInt(input.safetyFactorBps);
  const denominator = 60n * BigInt(RATE_PRECISION) * WHOLE_BPS;
  const demand = (numerator + denominator - 1n) / denominator;

  // A channel always needs a positive deposit, even when the policy sets no minimum.
  const floor = minDeposit > 0n ? minDeposit : 1n;

  let ceiling: bigint | undefined = maximum;
  let ceilingSource = "maximum";
  if (headroom !== undefined && (ceiling === undefined || headroom < ceiling)) {
    ceiling = headroom;
    ceilingSource = "headroom";
  }
  if (ceiling !== undefined && ceiling < floor) {
    return {
      open: false,
      reason: `${ceilingSource} ${ceiling} below minimum deposit ${floor}`,
    };
  }

  if (ceiling !== undefined && demand > ceiling) {
    return {
      open: true,
      deposit: ceiling.toString(),
      reason: `predicted demand ${demand} is capped at ${ceiling} by the ${ceilingSource}`,
    };
  }
  if (demand < floor) {
    return {
      open: true,
      deposit: floor.toString(),
      reason: `predicted demand ${demand} is below the minimum deposit ${floor}; depositing the minimum`,
    };
  }
  return {
    open: true,
    deposit: demand.toString(),
    reason: `predicted demand ${demand} over ${input.horizonSeconds}s, with safety factor ${input.safetyFactorBps} bps`,
  };
}
