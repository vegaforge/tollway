/**
 * Typed data layer for the channels view.
 *
 * The channels view (src/app/channels/page.tsx) depends on
 * @tollway/observability, which is tracked in issue #31. Until #31 lands,
 * this module is the single seam where the UI talks to the data. Replacing
 * `fetchOpenChannels` with a real rollup against the observability hub (or
 * a direct ChannelManager.list iteration) is a one-import change; everything
 * downstream stays the same.
 *
 * See docs/design.md, "The channel lifecycle manager".
 */

import type { ChannelStatus } from "@tollway/channels";

/**
 * One row in the open-channels table. Amounts are integer strings in the
 * asset's smallest unit, matching the canonical Channel shape in
 * @tollway/channels. The table formats them for display; the data layer
 * does not.
 */
export type OpenChannelRow = {
  /** Stable channel id, used as the React key. */
  id: string;
  /** Counterparty address or label. */
  counterparty: string;
  /** Initial deposit in the asset's smallest unit. */
  deposit: string;
  /** Cumulative committed so far in the asset's smallest unit. */
  committed: string;
  /** Highest commitment sequence issued; -1 before any commit lands. */
  sequence: number;
  status: ChannelStatus;
  /** Asset code, e.g. "USDC". */
  asset: string;
};

/**
 * Snapshot returned by the data source. Wrapping the rows in an object keeps
 * the seam stable when the observability hub starts returning metadata
 * alongside the list (cursors, generated-at timestamps, and so on) without
 * forcing every consumer to update.
 */
export type OpenChannelsSnapshot = {
  rows: OpenChannelRow[];
};

/**
 * The single seam between the dashboard and the channels data source.
 *
 * Today this returns a small, deterministic stub covering every ChannelStatus
 * variant plus one nearing-close case so the UI, the nearing-close indicator,
 * and the loading / error / empty states all light up without waiting on #31.
 * When the hub ships, swap the body for the real rollup and leave the
 * signature alone.
 */
export async function fetchOpenChannels(): Promise<OpenChannelsSnapshot> {
  return { rows: STUB_ROWS };
}

const STUB_ROWS: OpenChannelRow[] = [
  {
    id: "ch-stripe-01",
    counterparty: "GCSTRIPE...XYZ",
    deposit: "5000000000",
    committed: "1250000000",
    sequence: 42,
    status: "open",
    asset: "USDC",
  },
  {
    id: "ch-anthropic-02",
    counterparty: "GANTHROPIC...ABC",
    deposit: "10000000000",
    committed: "8600000000",
    sequence: 187,
    status: "open",
    asset: "USDC",
  },
  {
    id: "ch-openai-03",
    counterparty: "GOPENAI...QRS",
    deposit: "2000000000",
    committed: "1980000000",
    sequence: 96,
    status: "closing",
    asset: "USDC",
  },
  {
    id: "ch-perplexity-04",
    counterparty: "GPERPLEX...JKL",
    deposit: "1000000000",
    committed: "0",
    sequence: -1,
    status: "recovering",
    asset: "USDC",
  },
];
