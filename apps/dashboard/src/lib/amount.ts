/**
 * Display formatting for integer base-unit amounts. Stellar assets (USDC and
 * XLM through their SACs) use 7 decimals, the dashboard's default until the
 * service attaches per-asset metadata. Formatting is exact: digits are never
 * rounded or truncated, because a budget page that rounds can hide the
 * difference between at and over a limit.
 */

export const DEFAULT_ASSET_DECIMALS = 7;

export function formatUnits(amount: bigint, decimals = DEFAULT_ASSET_DECIMALS): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = (magnitude / divisor).toLocaleString("en-US");
  const fraction = (magnitude % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** `50.5 USDC`, for an integer base-unit string. */
export function formatAssetAmount(amount: string, asset: string): string {
  return `${formatUnits(BigInt(amount))} ${asset}`;
}

/** Basis points (1% = 100) as a percentage with two decimals, `12.34%`. */
export function formatBasisPoints(basisPoints: bigint): string {
  const whole = basisPoints / 100n;
  const fraction = basisPoints % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}%`;
}
