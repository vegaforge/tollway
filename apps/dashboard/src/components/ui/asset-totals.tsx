import { type AssetTotal, formatAmount } from "@/lib/amount";

/**
 * A headline total with one amount per asset, separated by a dot. Amounts in
 * different assets are never added together, so each one names its asset.
 * With no entries it reads "None" rather than a zero that names no asset.
 */
export function AssetTotals({ entries }: { entries: AssetTotal[] }) {
  if (entries.length === 0) return <>None</>;
  return (
    <>
      {entries.flatMap((entry, index) => [
        ...(index > 0 ? [<span key={`separator-${entry.asset}`}> · </span>] : []),
        <span key={entry.asset}>{formatAmount(entry.amount, entry.asset)}</span>,
      ])}
    </>
  );
}
