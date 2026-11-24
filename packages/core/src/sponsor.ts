import type { StellarNetwork } from "./types.js";

/** Latest attempt to read a fee sponsor. Stale readings carry no current balance. */
export type SponsorBalanceReading = {
  account: string;
  network: StellarNetwork;
  /** ISO 8601 time at which this attempt completed. */
  at: string;
} & ({ stale: false; balanceStroops: string } | { stale: true; error: string });

/** One low-balance episode, with native XLM amounts in integer stroops. */
export type SponsorLowBalanceEvent = {
  type: "sponsor.low_balance";
  at: string;
  data: {
    account: string;
    network: StellarNetwork;
    balanceStroops: string;
    thresholdStroops: string;
    hysteresisStroops: string;
  };
};
