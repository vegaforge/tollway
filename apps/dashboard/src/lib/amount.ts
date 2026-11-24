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

/** The asset code without its issuer: `USDC:GA5Z...` shows as `USDC`. */
export function assetCode(asset: string): string {
  return asset.split(":")[0] ?? asset;
}

/**
 * The shared display form for table cells and headline totals: `1,234.5 USDC`.
 * The fraction keeps every digit the amount has, padded to at least two places,
 * so nothing is rounded or truncated. A value that is not a non-negative integer
 * string is shown as received, so a bad value stays visible.
 */
export function formatAmount(
  amount: string,
  asset: string,
  decimals = DEFAULT_ASSET_DECIMALS,
): string {
  const code = assetCode(asset);
  if (!/^[0-9]+$/.test(amount)) return `${amount} ${code}`;
  const text = formatUnits(BigInt(amount), decimals);
  if (decimals === 0) return `${text} ${code}`;
  const [whole = "0", fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(2, "0")} ${code}`;
}

export type AssetTotal = { asset: string; amount: string };

/**
 * Sums `pick(row)` for each asset. Amounts in different assets are never added
 * together, so a headline total names every asset it covers.
 */
export function sumByAsset<T extends { asset: string }>(
  rows: readonly T[],
  pick: (row: T) => string,
): AssetTotal[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.asset, (totals.get(row.asset) ?? 0n) + BigInt(pick(row)));
  }
  return [...totals.entries()].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}
